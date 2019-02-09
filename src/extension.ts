import { workspace, ExtensionContext, TextDocumentChangeEvent, window, commands, Uri, Terminal, Disposable, TerminalRenderer, TreeView } from 'vscode';
import { debounce } from "lodash";
import { GitLogTreeProvider } from './git-log-tree-provider';
import * as path from "path";
import { fs } from "mz";
import { GitRepo } from './git-repo';
import { Commit } from './git-helpers';

const TERMINAL_DATA_FILE_NAME = "terminal-data.txt";

function getFirstWorkspaceFolder(): string | null {
	const folders = workspace.workspaceFolders;
	if (!folders) {
		return null;
	}
	return folders[0].uri.fsPath;
}

export function activate(context: ExtensionContext) {
	// Currently only handling one workspace use-case. TODO: handle multiple workspaces

	let repo: GitRepo;
	let workingDir: string;
	let terminalBufferData = "";
	let treeProvider: GitLogTreeProvider;
	let treeView: TreeView<Commit>;
	let debouncedDoSaveWithTerminalData;
	let activeTerminalListener: Disposable | undefined;
	let terminalRenderer: TerminalRenderer;
	asyncErrorHandler(initialize)();

	async function initialize(): Promise<void> {
		const workspaceFolder = getFirstWorkspaceFolder();
		if (!workspaceFolder) {
			window.showErrorMessage("Warning: no workspace found");
			return;
		} else {
			workingDir = workspaceFolder;
		}
		repo = await GitRepo.initialize(workingDir);
		treeProvider = new GitLogTreeProvider(repo);
		treeView = window.createTreeView("driveBy", { treeDataProvider: treeProvider });
		createCustomTerminal();
		trackTerminals();
		debouncedDoSaveWithTerminalData = debounce(doSaveWithTerminalData, 250);
		commands.registerCommand("driveBy.restore", asyncErrorHandler(restore));
		commands.registerCommand("driveBy.next", asyncErrorHandler(next));
		commands.registerCommand("driveBy.previous", asyncErrorHandler(previous));
		workspace.onDidChangeWorkspaceFolders(asyncErrorHandler(initialize));
		const onChange = debounce(asyncErrorHandler(onChangeDocument), 500);
		workspace.onDidChangeTextDocument(onChange);
		window.onDidChangeActiveTextEditor(asyncErrorHandler(onChangeActiveTextEditor));
	}

	function registerTerminal(terminal: Terminal): Disposable {
		return terminal.onDidWriteData(async (data: string) => {
			terminalBufferData += data;
			debouncedDoSaveWithTerminalData();
		});
	}

	async function next() {
		await repo.advanceToNextCommit();
		await postRestoreCommit();
	}

	async function previous() {
		await repo.revertToPreviousCommit();
		await postRestoreCommit();
	}

	async function onChangeDocument(changeEvent: TextDocumentChangeEvent) {
		await repo.save();
	}

	async function onChangeActiveTextEditor(editor) {
		if (editor) {
			await repo.save();
		}
	}

	function createCustomTerminal() {
		terminalRenderer = window.createTerminalRenderer('Replay Term');
		terminalRenderer.onDidAcceptInput((input) => {
			terminalRenderer.write("\rDon't type in here. This is a replay terminal!\r");
		});
		terminalRenderer.terminal.show();
	}

	function trackTerminals() {
		if (window.activeTerminal) {
			activeTerminalListener = registerTerminal(window.activeTerminal);
		}
		window.onDidChangeActiveTerminal((terminal) => {
			if (activeTerminalListener) {
				activeTerminalListener.dispose();
			}
			if (terminal) {
				activeTerminalListener = registerTerminal(terminal);
			}
		});
	}

	async function postRestoreCommit(): Promise<void> {
		const head = repo.head;
		if (!head) {
			window.showErrorMessage("Warning: no head found.");
			return;
		}
		const commit = repo.getCommit(head);
		if (!commit) {
			window.showErrorMessage("Warning: no commit found for head.");
			return;
		}
		if (commit) {
			// Open the file if it's a single file change - as long as its not
			// the terminal data file.
			if (commit.changedFiles.length === 1 && 
				commit.changedFiles[0].fileName !== TERMINAL_DATA_FILE_NAME) {
				const uri = Uri.file(path.join(workingDir, commit.changedFiles[0].fileName));
				window.showTextDocument(uri);
			}
			
			if (treeView.visible) {
				treeView.reveal(commit, { select: true });
			}
		}

		const terminalDataFilePath = path.join(workingDir, TERMINAL_DATA_FILE_NAME);
		try {
			const terminalData = (await fs.readFile(terminalDataFilePath)).toString();
			terminalRenderer.write(terminalData);
		} catch (e) {
			// if terminal data file doesn't exist, do nothing
		}
	}

	async function doSaveWithTerminalData(): Promise<void> {
		const beforeSave = async () => {
			await fs.writeFile(path.join(workingDir, TERMINAL_DATA_FILE_NAME), terminalBufferData);
			terminalBufferData = "";
		};
		await repo.save(beforeSave);
	}

	async function restore(commit: Commit): Promise<void> {
		if (commit) {
			await repo.restoreCommit(commit.sha);
			await postRestoreCommit();
		}
	}

}

function asyncErrorHandler(fn: (...args) => Promise<any>): () => Promise<any> {
	return async (...args) => {
		try {
			await fn(...args);
		} catch (e) {
			console.log(e.stack);
			window.showInformationMessage(e.stack);
		}
	};
}

export function deactivate() {}
