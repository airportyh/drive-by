import * as vscode from "vscode";
import { workspace, ExtensionContext, TextDocumentChangeEvent, window, commands, Uri, Terminal, Disposable, TreeView, env, Selection, TextEditorRevealType, TextEditor, Pseudoterminal } from 'vscode';
import { GitRepo } from './git-repo';
import { Commit, getBranches, ensureGitInitialized, isGitInitialized, restoreToBranch, getCommitDiff, getChangeRanges, ChangeRanges, Range, Position } from './git-helpers';
import { debounce, findLastIndex, findIndex } from "lodash";
import { GitLogTreeProvider } from './git-log-tree-provider';
import * as path from "path";
import { fs } from "mz";
import { CantUseTreeProvider, MenuTreeProvider } from './extra-tree-providers';
import { asyncErrorHandler } from './async-error-handler';
import { fileExists } from './fs-helpers';
import { delay } from "./delay";

type WorkingDirState = {
	activeBranch?: string;
	showSections?: boolean;
}

export class DriveBy {
	context: ExtensionContext;
	repo: GitRepo | null = null;
	workingDir: string;
	terminalBufferData = "";
	treeProvider?: GitLogTreeProvider;
	treeView: TreeView<Commit> | null = null;
	shortDebouncedSave: () => Promise<any>;
	longDebouncedSave: () => Promise<any>;
	disposables: Disposable[] = [];
	activeTerminalListener: Disposable | null = null;
	terminal: Terminal | null = null;
	terminalWriteEmitter: vscode.EventEmitter<string> | null = null;
	TERMINAL_DATA_FILE_NAME = "terminal-data.txt";

	constructor(context: ExtensionContext) {
		this.context = context;
	}

	async initialize(): Promise<void> {
		this.registerCommand("driveBy.start", this.startSession);
		this.registerCommand("driveBy.restore", this.restore);
		this.registerCommand("driveBy.next", this.next);
        this.registerCommand("driveBy.previous", this.previous);
		this.registerCommand("driveBy.stop", this.stopSession);
		this.registerCommand("driveBy.beginSection", this.beginSection);
		this.registerCommand("driveBy.toggleSections", this.toggleSections);
		this.registerCommand("driveBy.copyCommitSha", this.copyCommitSha);
		this.registerCommand("driveBy.branchHere", this.branchHere);
		this.registerCommand("driveBy.reset", this.reset);
		this.registerCommand("driveBy.switchBranch", this.switchBranch);
		this.registerCommand("driveBy.revertToCommit", this.resetToCommit);
		workspace.onDidChangeWorkspaceFolders(asyncErrorHandler(() => this.initializeSession()));
		await this.initializeSession();
	}

	async initializeSession(): Promise<void> {
		this.cleanUp();
		if (!workspace.workspaceFolders || workspace.workspaceFolders.length > 1) {
			// can't use drive by
			this.treeView = window.createTreeView("driveBy", { treeDataProvider: new CantUseTreeProvider() });
			return;
		}
		const folder = workspace.workspaceFolders[0];
		this.workingDir = folder.uri.fsPath;
		if (this.workingDirState.activeBranch) {
			await this.activateSession();
			if (this.repo && this.repo.head) {
				const headCommit = this.repo.getCommit(this.repo.head);
				if (headCommit) {
					this.showProgressInStatusBar();
				}
			}
		} else {
			this.treeView = window.createTreeView("driveBy", { treeDataProvider: new MenuTreeProvider() });
		}
	}

	get workingDirState(): WorkingDirState {
		return this.context.globalState.get<WorkingDirState>(this.workingDir) || {};
	}

	async saveWorkingDirState(state: WorkingDirState): Promise<void> {
		await this.context.globalState.update(this.workingDir, state);
	}

	get showSections(): boolean {
		return this.workingDirState && this.workingDirState.showSections || false;
	}

	getFirstWorkspaceFolder(): string | null {
		const folders = workspace.workspaceFolders;
		if (!folders) {
			return null;
		}
		return folders[0] && folders[0].uri.fsPath;
	}

	registerCommand(command: string, method: (any) => Promise<any>): void {
		commands.registerCommand(command, asyncErrorHandler(method.bind(this)));
	}

	async startSession(): Promise<void> {
        if (!(await isGitInitialized(this.workingDir))) {
            const choice = await window.showQuickPick(["Yes", "No"], {
                placeHolder: "You need a git repository to use Drive By. Initialize it now?"
            });
            if (choice !== "Yes") {
                return;
            }
            await ensureGitInitialized(this.workingDir);
        }
        const branch = await this.promptForBranch();
        if (branch) {
			await this.saveWorkingDirState({
				...this.workingDirState, 
				activeBranch: branch
			});
            await this.activateSession();
        }
	}
	
	async copyCommitSha(commit: Commit): Promise<void> {
		await env.clipboard.writeText(commit.sha);
	}

	async branchHere(commit: Commit): Promise<void> {
		if (!this.repo) {
			return;
		}
		const branch = await this.promptForNewBranch();
		
		if (branch) {
			await this.saveWorkingDirState({
				...this.workingDirState, 
				activeBranch: branch
			});
			await this.repo.branchFrom(commit.sha, branch);
			this.showProgressInStatusBar();
		}
	}

	async switchBranch(): Promise<void> {
		if (!this.repo) {
			return;
		}
		const branch = await this.promptForExistingBranch();
		if (branch) {
			await this.saveWorkingDirState({
				...this.workingDirState, 
				activeBranch: branch
			});
			await this.repo.switchBranch(branch);
			this.showProgressInStatusBar();
		}
	}
    
    async stopSession(): Promise<void> {
		const branch = this.workingDirState.activeBranch;
        if (branch) {
			await this.saveWorkingDirState({});
            await restoreToBranch(this.workingDir, branch);
            await this.initializeSession();
        }
	}
	
	async promptForNewBranch(): Promise<string | undefined> {
		const branches = await getBranches(this.workingDir);
		let result = await window.showInputBox({
			prompt: "Create a new branch"
		});
		if (result && branches.indexOf(result) !== -1) {
			window.showErrorMessage(`Cannot create branch ${result}: it already exists.`);
		} else {
			return result;
		}
		return undefined;
	}

	async promptForExistingBranch(): Promise<string | undefined> {
		const branches = await getBranches(this.workingDir);
		return await window.showQuickPick(branches, {
			placeHolder: "Which branch to switch to?"
		});
	}

	async promptForBranch(): Promise<string | undefined> {
		const branches = await getBranches(this.workingDir);
		const CREATE_NEW = "Create new...";
		const choices: string[] = [
			...branches,
			CREATE_NEW
		];
		let result = await window.showQuickPick(choices, {
			placeHolder: "Which branch to record on?"
		});
		if (result) {
			if (result === CREATE_NEW) {
				result = await this.promptForNewBranch();
			}
			if (result) {
				return result;
			}
		}
		return undefined;
	}

	async activateSession(): Promise<void> {
		const folder = this.getFirstWorkspaceFolder();
		if (!folder) {
			throw new Error("No workspace folder found");
		}
		if (!this.workingDirState.activeBranch) {
			throw new Error("Expected active branch, but non found");
		}
		this.createReplayTerminal();
		this.trackActiveTerminal();
		this.shortDebouncedSave = debounce(asyncErrorHandler(() => this.save()), 250);
		this.longDebouncedSave = debounce(asyncErrorHandler(() => this.shortDebouncedSave()), 500);
		this.pushDisposable(workspace.onDidChangeTextDocument(this.longDebouncedSave));
		this.pushDisposable(window.onDidChangeActiveTextEditor(this.longDebouncedSave));
		this.repo = await GitRepo.initialize(this.workingDir, this.workingDirState.activeBranch);
		this.treeProvider = new GitLogTreeProvider(this.repo, this.workingDirState.showSections || false);
		this.treeView = window.createTreeView("driveBy", {
			treeDataProvider: this.treeProvider
		});
	}

	async beginSection(commit: Commit): Promise<void> {
		if (!this.repo) {
			return;
		}
		const message = await window.showInputBox({
			prompt: "Write name of section"
		});
		if (message) {
			await this.repo.createAnnotation(commit.sha, message);
		}
	}

	async toggleSections(): Promise<void> {
		if (this.treeProvider) {
			const state = this.workingDirState;
			const newState = {...state, showSections: !state.showSections};
			await this.saveWorkingDirState(newState);
			this.treeProvider.showSections = newState.showSections;
		}
	}

	waitForTextDocumentChangeEvent(): Promise<void> {
		return new Promise((accept) => {
			const unlisten = workspace.onDidChangeTextDocument((e) => {
				unlisten.dispose();
				accept();
			});
			setTimeout(() => {
				unlisten.dispose();
				accept();
			}, 500);
		});
	}

	async resetToCommit(commit: Commit): Promise<void> {
		if (!this.repo) {
			return;
		}
		await this.repo.resetToCommit(commit.sha);
		this.showProgressInStatusBar();
	}

	createReplayTerminal(): void {
		this.terminalWriteEmitter = new vscode.EventEmitter<string>();
		const pty: Pseudoterminal = {
			onDidWrite: this.terminalWriteEmitter.event,
			open() {},
			close() {},
			handleInput: (input: string) => {
				if (this.terminalWriteEmitter) {
					this.terminalWriteEmitter.fire("\rDon't type in here. This is a replay terminal!\r");
				}
			}
		};
		this.terminal = window.createTerminal({ name: 'Replay Term', pty } as any);
		this.pushDisposable(this.terminal);
	}

	trackActiveTerminal(): void {
		window.onDidWriteTerminalData(async (e) => {
			const data = e.data;
			this.terminalBufferData += data;
			this.shortDebouncedSave();
		});
	}

	removeActiveTerminalListener(): void {
		if (this.activeTerminalListener) {
			this.activeTerminalListener.dispose();
		}
	}

	pushDisposable(disposable: Disposable | null): void {
		if (disposable) {
			this.disposables.push(disposable);
		}
	}

	postRestoreCommit(commit: Commit): void {
		this.showProgressInStatusBar();
		this.revealInTreeView(commit);
		this.renderTerminalData();
	}

	isIndividualFileCommit(commit: Commit): boolean {
		const terminalChanges = commit
			.changedFiles
			.filter(file => file.fileName === this.TERMINAL_DATA_FILE_NAME);
		const nonTerminalChanges = commit
			.changedFiles
			.filter(file => file.fileName !== this.TERMINAL_DATA_FILE_NAME);
		return terminalChanges.length === 0 && nonTerminalChanges.length === 1;
	}

	showProgressInStatusBar() {
		if (this.repo) {
			const head = this.repo.head;
			if (!head) {
				window.showErrorMessage("Warning: no head found.");
				return;
			}
			const commit = this.repo.getCommit(head);
			if (!commit) {
				window.showErrorMessage("Warning: no commit found for head.");
				return;
			}
			const sectionStart = this.repo.getSectionStart(commit.sha);
			const branch = this.repo.state.branch;
			if (sectionStart) {
				const sectionTitle = this.repo.getAnnotation(sectionStart);
				const commitCount = this.repo.getSectionCommitCount(sectionStart);
				if (this.repo.isHeadInSection(sectionStart)) {
					const stepNumber = this.repo.stepNumberOfHead(sectionStart);
					window.setStatusBarMessage(`[${branch}]: ${sectionTitle} ${stepNumber} / ${commitCount}`);
				} else {
					window.setStatusBarMessage(`[${branch}]: ${sectionTitle}`)
				}
			} else {
				window.setStatusBarMessage(`[${branch}]`);
			}
		}
	}

	revealInTreeView(commit: Commit) {
		if (this.treeView && this.treeView.visible) {
			this.treeView.reveal(commit, { select: true });
		}
	}

	async renderTerminalData(): Promise<void> {
		const terminalDataFilePath = path.join(this.workingDir, this.TERMINAL_DATA_FILE_NAME);
		try {
			const terminalData = (await fs.readFile(terminalDataFilePath)).toString();
			if (this.terminalWriteEmitter) {
				this.terminalWriteEmitter.fire(terminalData);
			}
		} catch (e) {
			// if terminal data file doesn't exist, do nothing
		}
	}

	async showFileAndSelectTextRange(fileName: string, changeRange?: Range): Promise<void> {
		const filePath = path.join(this.workingDir, fileName);
		const uri = Uri.file(filePath);
		const selection = changeRange && new vscode.Range(
			this.convertPosition(changeRange.start), 
			this.convertPosition(changeRange.end));
		await window.showTextDocument(uri, { selection });
	}

	async showFile(fileName: string): Promise<void> {
		await this.showFileAndSelectTextRange(fileName);
	}

	async getChangeRanges(commit: Commit): Promise<ChangeRanges | undefined> {
		return await getChangeRanges(this.workingDir, commit.sha);
	}

	async save(): Promise<void> {
		if (!this.repo) {
			return;
		}
		const beforeSave = async () => {
			await fs.writeFile(path.join(this.workingDir, this.TERMINAL_DATA_FILE_NAME), this.terminalBufferData);
			this.terminalBufferData = "";
		};
		await this.repo.save(beforeSave);
	}

	async restore(commit: Commit | null): Promise<void> {
		if (!commit || !this.repo) {
			return;
		}
		if (this.isIndividualFileCommit(commit)) {
			const fileName = commit.changedFiles[0].fileName;
			const changeRanges = await this.getChangeRanges(commit);
			await this.restoreCommit(commit);
			await this.waitForTextDocumentChangeEvent();
			await this.showFileAndSelectTextRange(fileName, changeRanges && changeRanges.after);
		} else {
			await this.restoreCommit(commit);
		}
	}

	async next(): Promise<void> {
		if (!this.repo) {
			return;
		}
		const commit = this.repo.getNextCommit();	
		if (!commit) {
			return;
		}
		const changeRanges = await this.getChangeRanges(commit);
		const isIndividual = this.isIndividualFileCommit(commit);
		if (isIndividual && changeRanges) {
			this.animateChange(
				commit, 
				commit.changedFiles[0].fileName, 
				changeRanges.before, changeRanges.after);
		} else {
			await this.restoreCommit(commit);
		}
	}

	async previous(): Promise<void> {
		if (!this.repo) {
			return;
		}
		const commitToRestore = this.repo.getPreviousCommit();
		const commitToAnimate = this.repo.getHeadCommit();
		
		if (!commitToRestore || !commitToAnimate) {
			return;
		}
		let changeRanges: ChangeRanges | undefined;
		if (this.isIndividualFileCommit(commitToAnimate) && 
			(changeRanges = await this.getChangeRanges(commitToAnimate))) {
			this.animateChange(
				commitToRestore, 
				commitToAnimate.changedFiles[0].fileName, 
				changeRanges.after, 
				changeRanges.before);
		} else {
			await this.restoreCommit(commitToRestore);
		}
	}

	async animateChange(
		commitToRestore: Commit, 
		fileName: string,
		fromRange: Range, toRange: Range): Promise<void> {
		const activeTextEditor = window.activeTextEditor;
		if (activeTextEditor && this.isFileOpenInEditor(activeTextEditor, fileName)) {
			// the changed file for which we are animating is in the current text editor
			if (this.isPositionVisible(fromRange.start, activeTextEditor.visibleRanges)) {
				// changed range is already visible in the editor: animate it
				this.selectTextRange(activeTextEditor, fromRange);
				await delay(100);
				await this.restoreCommit(commitToRestore);
				await this.waitForTextDocumentChangeEvent();
				this.selectTextRange(activeTextEditor, toRange);
			} else {
				// changed range is not visible in the editor: reveal it (don't restore commit)
				this.centerToPosition(activeTextEditor, fromRange.start);
				this.selectTextRange(activeTextEditor, fromRange);
			}
		} else {
			// the changed file for which we are reverting isn't in the current text editor
			if (await this.fileExists(fileName)) {
				// open the file and reveal the changed range (don't restore commit)
				this.showFileAndSelectTextRange(fileName, fromRange);
			} else {
				// changed file does not exist: restore and open it
				await this.restoreCommit(commitToRestore);
				await this.showFileAndSelectTextRange(fileName, toRange);
			}
		}
	}

	convertPosition(position: Position): vscode.Position {
		return new vscode.Position(position.line - 1, position.character - 1);
	}

	isPositionVisible(position: Position, visibleRanges: vscode.Range[]): boolean {
		const pos = this.convertPosition(position);
		const changeBegin = new vscode.Range(pos, pos);
		return visibleRanges
			.some((range) => range.contains(changeBegin));
	}

	selectTextRange(textEditor: TextEditor, range: Range): void {
		const start = this.convertPosition(range.start);
		const end = this.convertPosition(range.end);
		textEditor.selection = new Selection(start, end);
	}

	centerToPosition(textEditor: TextEditor, position: Position): void {
		const pos = this.convertPosition(position);
		textEditor.revealRange(
			new Selection(pos, pos), 
			TextEditorRevealType.InCenter
		);
	}

	isFileOpenInEditor(textEditor: TextEditor, fileName: string): boolean {
		const activeFilePath = textEditor.document.fileName;
		const relativeActiveFilePath = path.relative(this.workingDir, activeFilePath);
		return relativeActiveFilePath === fileName;
	}

	async fileExists(relativeFilePath: string): Promise<boolean> {
		const fullPath = path.join(this.workingDir, relativeFilePath);
		return fileExists(fullPath);
	}

	async restoreCommit(commit: Commit): Promise<void> {
		if (this.repo) {
			await this.repo.restoreCommit(commit.sha);
			await this.postRestoreCommit(commit);
		}
	}

	async reset(): Promise<void> {
		if (this.repo && this.repo.head) {
			const commit = this.repo.getCommit(this.repo.head);
			if (commit) {
				this.restore(commit);
			}
		}
	}

	cleanUp(): void {
		this.removeActiveTerminalListener();
		this.activeTerminalListener = null;
		this.terminal = null;
		this.terminalBufferData = "";
		if (this.treeView) {
			this.treeView.dispose();
			this.treeView = null;
		}
		this.repo = null;
		this.disposeDisposables();
	}

	disposeDisposables(): void {
		for (let disposable of this.disposables) {
			disposable.dispose();
		}
		this.disposables = [];
	}

}

