// TODO: https://stackoverflow.com/questions/1386291/git-git-dir-not-working-as-expected

import { workspace, ExtensionContext, TextDocumentChangeEvent, window, commands, TreeDataProvider, WorkspaceFolder, EventEmitter, Event, TreeItem, TreeItemCollapsibleState, Uri, Terminal, Disposable, TerminalRenderer } from 'vscode';
import { debounce } from "lodash";
import { getHead, getMasterHead, reset, restoreToHead, restoreCommit, save, isGitInitialized, ensureGitInitialized, getChangedFiles, getCommitShas } from "./git-helpers";
import { ChangeLogTreeProvider, ChangeTreeNode } from './change-log-tree-provider';
import { delay } from './delay';
import { JobQueue } from './job-queue';
import * as path from "path";
import { fs } from "mz";
import { fileExists } from './fs-helpers';

const TERMINAL_DATA_FILE_NAME = "terminal-data.txt";

function getFirstWorkspaceFolder(): string | null {
	const folders = workspace.workspaceFolders;
	if (!folders) {
		return null;
	}
	return folders[0].uri.fsPath;
}

function getWorkspaceFolder(filePath: string): string | null {
	const folders = workspace.workspaceFolders;
	if (!folders) {
		return null;
	}
	for (let folder of folders) {
		if (filePath.indexOf(folder.uri.fsPath) === 0) {
			return folder.uri.fsPath;
		}
	}
	return null;
}

export function activate(context: ExtensionContext) {
	let saveRefCount = 0;
	const jobQueue = new JobQueue();
	let terminalBufferData = "";
	const treeProvider = new ChangeLogTreeProvider(jobQueue);
	let activeTerminalListener: Disposable | undefined;
	let state: string = "idle";
	let terminalRenderer: TerminalRenderer;
	window.registerTreeDataProvider("driveBy", treeProvider);
	errorHandler(createCustomTerminal)();
	trackTerminals();

	function createCustomTerminal() {
		terminalRenderer = window.createTerminalRenderer('Replay Term');
		terminalRenderer.onDidAcceptInput((input) => {
			terminalRenderer.write("\rDon't type in here. This is a replay terminal!")
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

	const debouncedDoSaveWithTerminalData = debounce(doSaveWithTerminalData, 250);

	function registerTerminal(terminal: Terminal): Disposable {
		return terminal.onDidWriteData(async (data: string) => {
			// window.showInformationMessage("terminal: " + data);
			terminalBufferData += data;
			debouncedDoSaveWithTerminalData();
			// window.showInformationMessage("terminal:" + JSON.stringify(data));
			// if (data === "\r\n") {
			// 	// they issued a command
			// 	window.showInformationMessage("You issued command: " + currentCommand);
			// 	currentCommand = "";
			// } else if (data.match(/\r\n/)) {
			// 	// this is the reply by the command
			// 	// this may not be true if process progressively
			// 	// prints characters
			// 	window.showInformationMessage("Process replied: " + data);
			// 	const folder = getFirstWorkspaceFolder();
			// 	if (folder) {
			// 		await doSave(folder);
			// 	}
			// } else {
			// 	currentCommand += data;
			// }
		});
	}

	commands.registerCommand("driveBy.refresh", errorHandler(() => {
		refresh();
	}));

	commands.registerCommand("driveBy.restore", asyncErrorHandler(async(node: ChangeTreeNode) => {
		if (!node) {
			window.showInformationMessage("Warning: no changed node for a restore");
			return;
		}
		const folder = node.folder;
		await jobQueue.push(async () => doRestoreCommit(folder, node.sha));
	}));

	commands.registerCommand("driveBy.toggleReplay", asyncErrorHandler(async() => {
		// Currently only handling one workspace use-case. TODO: handle multiple workspaces
		const workspaceFolder = workspace.workspaceFolders && workspace.workspaceFolders[0];
		if (workspaceFolder) {
			const folder = workspaceFolder.uri.fsPath;
			await toggleReplay(folder);
		}
	}));

	commands.registerCommand("driveBy.next", asyncErrorHandler(async() => {
		// Currently only handling one workspace use-case. TODO: handle multiple workspaces
		const workspaceFolder = workspace.workspaceFolders && workspace.workspaceFolders[0];
		if (workspaceFolder) {
			const folder = workspaceFolder.uri.fsPath;
			state = "idle";
			await jobQueue.push(async () => {
				const head = await getHead(folder);
				if (!head) {
					return;
				}
				const commits = await getCommitShas(folder);
				const idx = commits.indexOf(head);
				if (idx === -1) {
					throw new Error("BLARG");
				}
				if (idx + 1 < commits.length) {
					const nextCommit = commits[idx + 1];
					await doRestoreCommit(folder, nextCommit);
				}
			});
		}
	}));

	commands.registerCommand("driveBy.previous", asyncErrorHandler(async() => {
		// Currently only handling one workspace use-case. TODO: handle multiple workspaces
		const workspaceFolder = workspace.workspaceFolders && workspace.workspaceFolders[0];
		if (workspaceFolder) {
			const folder = workspaceFolder.uri.fsPath;
			state = "idle";
			await jobQueue.push(async () => {
				const head = await getHead(folder);
				if (!head) {
					return;
				}
				const commits = await getCommitShas(folder);
				const idx = commits.indexOf(head);
				if (idx === -1) {
					throw new Error("BLARG");
				}
				if (idx - 1 >= 0) {
					const previousCommit = commits[idx - 1];
					await doRestoreCommit(folder, previousCommit);
				}
			});
		}
	}));

	workspace.onDidChangeWorkspaceFolders(errorHandler(() => {
		refresh();
	}));

	const onChange = debounce(asyncErrorHandler(async (changeEvent: TextDocumentChangeEvent) => {
		if (changeEvent) {
			const document = changeEvent.document;
			const filePath = document.uri.fsPath;
			const folder = getWorkspaceFolder(filePath);
			if (folder) {
				await jobQueue.push(async () => {
					await doSave(folder);
				});
			} else {
				window.showInformationMessage("No workspace found.");
			}
		} else {
			throw new Error("BLARGH");
		}
	}), 500);

	workspace.onDidChangeTextDocument(onChange);
	window.onDidChangeActiveTextEditor(asyncErrorHandler(async (editor) => {
		if (editor) {
			const filePath = editor.document.uri.fsPath;
			const folder = getWorkspaceFolder(filePath);
			if (folder) {
				await jobQueue.push(async () => {
					await doSave(folder);
				});
			}
		}
	}));

	async function toggleReplay(folder: string) {
		if (state === "replay") {
			state = "idle";
		} else {
			await jobQueue.push(() => replay(folder));
		}
	}

	async function replay(folder: string) {
		const head = await getHead(folder);
		if (!head) {
			return;
		}
		const commits = await getCommitShas(folder);
		let idx = commits.indexOf(head);
		if (idx === -1) {
			throw new Error("BLARG");
		}
		state = "replay";
		idx++;
		while (idx < commits.length) {
			const commit = commits[idx];
			
			await doRestoreCommit(folder, commit);
			await delay(200);
		
			if (state === "idle") {
				break;
			}
			idx++;
		}
		state = "idle";
	}

	async function doRestoreCommit(workingDir: string, sha: string): Promise<void> {
		await reset(workingDir);
		await restoreCommit(workingDir, sha);
		refresh();
		const changedFiles = await getChangedFiles(workingDir, sha);
		if (changedFiles.length === 1 && changedFiles[0] !== TERMINAL_DATA_FILE_NAME) {
			window.showTextDocument(Uri.file(path.join(workingDir, changedFiles[0])));
		}
		const terminalDataFilePath = path.join(workingDir, TERMINAL_DATA_FILE_NAME);
		if (await fileExists(terminalDataFilePath)) {
			const terminalData = (await fs.readFile(terminalDataFilePath)).toString();
			terminalRenderer.write(terminalData);
		}
	}

	async function doSaveWithTerminalData(): Promise<void> {
		const workingDir = getFirstWorkspaceFolder();
		if (!workingDir) {
			return;
		}
		jobQueue.push(async () => {
			const beforeSave = async () => {
				await fs.writeFile(path.join(workingDir, TERMINAL_DATA_FILE_NAME), terminalBufferData);
				terminalBufferData = "";
			};
			await doSave(workingDir, beforeSave);
		});
	}

	async function doSave(workingDir: string, beforeSave?: () => Promise<void>) {
		saveRefCount++;
		if (saveRefCount > 1) {
			window.showErrorMessage("Multiple processes are saving at the same time!!!");
			return;
		}
		const gitInitialized = await isGitInitialized(workingDir);
		if (!gitInitialized) {
			await ensureGitInitialized(workingDir);
		}
		const masterHead = await getMasterHead(workingDir);
		const head = await getHead(workingDir);
		
		if (masterHead === head) {
			if (beforeSave) {
				await beforeSave();
			}
			await save(workingDir);
		}
		refresh();
		saveRefCount--;
	}

	function refresh() {
		treeProvider.refresh();
	}
}


function errorHandler(fn: (...args) => any): () => any {
	return (...args) => {
		try {
			return fn(...args);
		} catch (e) {
			console.log(e.stack);
			window.showInformationMessage(e.stack);
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
