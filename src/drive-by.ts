import { workspace, ExtensionContext, TextDocumentChangeEvent, window, commands, Uri, Terminal, Disposable, TerminalRenderer, TreeView, Position, ShellExecution, Selection, Range, env } from 'vscode';
import { GitRepo } from './git-repo';
import { Commit, getBranches, ensureGitInitialized, isGitInitialized, restoreToBranch, getCommitDiff } from './git-helpers';
import { debounce, findLastIndex, findIndex } from "lodash";
import { GitLogTreeProvider } from './git-log-tree-provider';
import * as path from "path";
import { fs } from "mz";
import { CantUseTreeProvider, MenuTreeProvider } from './extra-tree-providers';
import { asyncErrorHandler } from './async-error-handler';
import * as util from "util";
import { delay } from './delay';

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
	debouncedDoSaveWithTerminalData;
	disposables: Disposable[] = [];
	activeTerminalListener: Disposable | null = null;
	terminalRenderer: TerminalRenderer | null = null;
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
		this.registerCommand("driveBy.reset", this.reset);
		workspace.onDidChangeWorkspaceFolders(asyncErrorHandler(() => this.initialize2()));
		await this.initialize2();
	}

	async initialize2(): Promise<void> {
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
    
    async stopSession(): Promise<void> {
        if (this.workingDirState.activeBranch) {
			await this.saveWorkingDirState({});
            await restoreToBranch(this.workingDir, this.workingDirState.activeBranch);
            await this.initialize2();
        }
    }

	async promptForBranch(): Promise<string | null> {
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
				result = await window.showInputBox({
					prompt: "Name the branch"
                });
                if (result && branches.indexOf(result) !== -1) {
					window.showErrorMessage(`Cannot create branch ${result}: it already exists.`);
				}
			}
			if (result) {
				return result;
			}
		}
		return null;
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
		this.debouncedDoSaveWithTerminalData = debounce(this.doSaveWithTerminalData, 250);
		const onChange = debounce(asyncErrorHandler(this.onChangeDocument.bind(this)), 500);
		this.pushDisposable(
			workspace.onDidChangeTextDocument(onChange));
		this.pushDisposable(
			window.onDidChangeActiveTextEditor(asyncErrorHandler(this.onChangeActiveTextEditor.bind(this))));
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

	registerTerminal(terminal: Terminal): Disposable {
		return terminal.onDidWriteData(async (data: string) => {
			this.terminalBufferData += data;
			this.debouncedDoSaveWithTerminalData();
		});
	}

	async next(): Promise<void> {
		if (!this.repo) {
			return;
		}
		await this.repo.advanceToNextCommit();
		await this.waitForTextDocumentChangeEvent();
		await this.postRestoreCommit();
	}

	async previous(): Promise<void> {
		if (!this.repo) {
			return;
		}
		await this.repo.revertToPreviousCommit();
		await this.waitForTextDocumentChangeEvent();
		await this.postRestoreCommit();
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
			if (!this.repo || !this.repo.head) {
				accept();
				return;
			}
			const head = this.repo.head;
			const commit = this.repo.getCommit(head);
			if (!commit) {
				accept();
				return;
			}
			if (commit) {
				// Open the file and select if it's a single file change - as long as its not
				// the terminal data file.
				if (commit.changedFiles.length === 1 && 
					commit.changedFiles[0].fileName !== this.TERMINAL_DATA_FILE_NAME) {
					const unlisten = workspace.onDidChangeTextDocument((e) => {
						unlisten.dispose();
						accept();
					});
				} else {
					accept();
				}
			}
		});
	}

	async onChangeDocument(changeEvent: TextDocumentChangeEvent) {
		if (!this.repo) {
			return;
		}
		await this.repo.save();
	}

	async onChangeActiveTextEditor(editor) {
		if (editor && this.repo) {
			await this.repo.save();
		}
	}

	createReplayTerminal(): void {
		this.terminalRenderer = window.createTerminalRenderer('Replay Term');
		this.terminalRenderer.onDidAcceptInput((input) => {
			if (this.terminalRenderer) {
				this.terminalRenderer.write("\rDon't type in here. This is a replay terminal!\r");
			}
		});
		this.terminalRenderer.terminal.show();
		this.pushDisposable(this.terminalRenderer.terminal);
	}

	trackActiveTerminal(): void {
		if (window.activeTerminal) {
			this.activeTerminalListener = this.registerTerminal(window.activeTerminal);
		}
		this.pushDisposable(window.onDidChangeActiveTerminal((terminal) => {
			this.removeActiveTerminalListener();
			if (terminal) {
				this.activeTerminalListener = this.registerTerminal(terminal);
			}
		}));
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

	async postRestoreCommit(): Promise<void> {
		if (!this.repo) {
			return;
		}
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
		if (commit) {
			// Open the file and select if it's a single file change - as long as its not
			// the terminal data file.
			if (commit.changedFiles.length === 1 && 
				commit.changedFiles[0].fileName !== this.TERMINAL_DATA_FILE_NAME) {
				await this.showAndSelectCurrentChange(commit);
			}
			
			if (this.treeView && this.treeView.visible) {
				this.treeView.reveal(commit, { select: true });
			}
		}

		const terminalDataFilePath = path.join(this.workingDir, this.TERMINAL_DATA_FILE_NAME);
		try {
			const terminalData = (await fs.readFile(terminalDataFilePath)).toString();
			if (this.terminalRenderer) {
				this.terminalRenderer.write(terminalData);
			}
		} catch (e) {
			// if terminal data file doesn't exist, do nothing
		}
	}

	async showAndSelectCurrentChange(commit: Commit): Promise<void> {
		const uri = Uri.file(path.join(this.workingDir, commit.changedFiles[0].fileName));
		await window.showTextDocument(uri);
		if (window.activeTextEditor) {
			const diff = await getCommitDiff(this.workingDir, commit.sha);
			const hunks = diff[0].hunks;
			const hunk = hunks[hunks.length - 1];
			const newLines = hunk.lines.filter((line) => line[0] !== "-");
			const firstNewLineIdx = findIndex(newLines, (line) => line[0] === "+");
			const firstDeletedLineIdx = findIndex(hunk.lines, (line) => line[0] === "-");
				
			let startPos: Position;
			let endPos: Position;
			
			if (firstNewLineIdx !== -1) {
				const firstLine = hunk.newStart + findIndex(newLines, (line) => line[0] === "+") - 1;
				const lastLine = hunk.newStart + findLastIndex(newLines, (line) => line[0] === "+") - 1;
				
				startPos = new Position(firstLine, 0);
				endPos = new Position(lastLine, Number.MAX_VALUE);
			} else {
				// a deletion
				const firstLine = hunk.newStart + firstDeletedLineIdx;
				startPos = new Position(firstLine, 0);
				endPos = startPos;
				
			}

			const range = new Range(startPos, endPos);
			window.activeTextEditor.revealRange(range);
			window.activeTextEditor.selection = new Selection(startPos, endPos);
		}
	}

	async doSaveWithTerminalData(): Promise<void> {
		if (!this.repo) {
			return;
		}
		const beforeSave = async () => {
			await fs.writeFile(path.join(this.workingDir, this.TERMINAL_DATA_FILE_NAME), this.terminalBufferData);
			this.terminalBufferData = "";
		};
		await this.repo.save(beforeSave);
	}

	async restore(commit: Commit): Promise<void> {
		if (commit && this.repo) {
			await this.repo.restoreCommit(commit.sha);
			await this.waitForTextDocumentChangeEvent();
			await this.postRestoreCommit();
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
		this.terminalRenderer = null;
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

