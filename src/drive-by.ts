import { workspace, ExtensionContext, TextDocumentChangeEvent, window, commands, Uri, Terminal, Disposable, TerminalRenderer, TreeView } from 'vscode';
import { GitRepo } from './git-repo';
import { Commit, getBranches, ensureGitInitialized, isGitInitialized, restoreToBranch } from './git-helpers';
import { debounce } from "lodash";
import { GitLogTreeProvider } from './git-log-tree-provider';
import * as path from "path";
import { fs } from "mz";
import { CantUseTreeProvider, MenuTreeProvider } from './extra-tree-providers';
import { asyncErrorHandler } from './async-error-handler';

export class DriveBy {
	context: ExtensionContext;
	repo: GitRepo | null = null;
	workingDir: string;
	terminalBufferData = "";
	treeProvider: GitLogTreeProvider;
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
		this.registerCommand("driveBy.annotate", this.annotate);
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
		const activeBranch: string | undefined = this.context.globalState.get(this.workingDir);
		if (activeBranch) {
			await this.activateSession();
		} else {
			this.treeView = window.createTreeView("driveBy", { treeDataProvider: new MenuTreeProvider() });
		}
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
            this.context.globalState.update(this.workingDir, branch);
            await this.activateSession();
        }
    }
    
    async stopSession(): Promise<void> {
        const branch: string | undefined = this.context.globalState.get(this.workingDir);
        if (branch) {
            this.context.globalState.update(this.workingDir, undefined);
            await restoreToBranch(this.workingDir, branch);
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
		const activeBranch: string | undefined = this.context.globalState.get(this.workingDir);
		if (!activeBranch) {
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
		this.repo = await GitRepo.initialize(this.workingDir, activeBranch);
		this.treeView = window.createTreeView("driveBy", {
			treeDataProvider: new GitLogTreeProvider(this.repo)
		});
	}

	async annotate(commit: Commit): Promise<void> {
		if (!this.repo) {
			return;
		}
		const message = await window.showInputBox({
			prompt: "Write a message"
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

	async next() {
		if (!this.repo) {
			return;
		}
		await this.repo.advanceToNextCommit();
		await this.postRestoreCommit();
	}

	async previous() {
		if (!this.repo) {
			return;
		}
		await this.repo.revertToPreviousCommit();
		await this.postRestoreCommit();
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
			// Open the file if it's a single file change - as long as its not
			// the terminal data file.
			if (commit.changedFiles.length === 1 && 
				commit.changedFiles[0].fileName !== this.TERMINAL_DATA_FILE_NAME) {
				const uri = Uri.file(path.join(this.workingDir, commit.changedFiles[0].fileName));
				window.showTextDocument(uri);
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
			await this.postRestoreCommit();
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

