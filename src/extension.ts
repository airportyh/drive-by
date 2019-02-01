// TODO: https://stackoverflow.com/questions/1386291/git-git-dir-not-working-as-expected

import { workspace, ExtensionContext, TextDocumentChangeEvent, window, commands, TreeDataProvider, WorkspaceFolder, EventEmitter, Event, TreeItem, TreeItemCollapsibleState, Uri, Terminal, Disposable, TerminalRenderer } from 'vscode';
import { debounce } from "lodash";
import { getHead, getMasterHead, reset, restoreCommit, save, isGitInitialized, ensureGitInitialized, getTop5ChangedFiles, getCommitShas } from "./git-helpers";
import { ChangeLogTreeProvider, CommitTreeNode } from './change-log-tree-provider';
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
	// Initialiation
	let saveRefCount = 0;
	const jobQueue = new JobQueue();
	let terminalBufferData = "";
	const treeProvider = new ChangeLogTreeProvider(jobQueue);
	let activeTerminalListener: Disposable | undefined;
	let state: string = "idle";
	let terminalRenderer: TerminalRenderer;
	const treeView = window.createTreeView("driveBy", { treeDataProvider: treeProvider });
	errorHandler(createCustomTerminal)();
	trackTerminals();
	const debouncedDoSaveWithTerminalData = debounce(doSaveWithTerminalData, 250);
	commands.registerCommand("driveBy.refresh", asyncErrorHandler(refresh));
	commands.registerCommand("driveBy.restore", asyncErrorHandler(restore));
	commands.registerCommand("driveBy.toggleReplay", asyncErrorHandler(toggleReplayCommand));
	commands.registerCommand("driveBy.next", asyncErrorHandler(next));
	commands.registerCommand("driveBy.previous", asyncErrorHandler(previous));
	commands.registerCommand("driveBy.nextEdit", asyncErrorHandler(nextEdit));
	workspace.onDidChangeWorkspaceFolders(asyncErrorHandler(refresh));
	const onChange = debounce(asyncErrorHandler(onChangeDocument), 500);
	workspace.onDidChangeTextDocument(onChange);
	window.onDidChangeActiveTextEditor(asyncErrorHandler(onChangeActiveTextEditor));

	function registerTerminal(terminal: Terminal): Disposable {
		return terminal.onDidWriteData(async (data: string) => {
			terminalBufferData += data;
			debouncedDoSaveWithTerminalData();
		});
	}

	async function toggleReplayCommand() {
		// Currently only handling one workspace use-case. TODO: handle multiple workspaces
		const workspaceFolder = workspace.workspaceFolders && workspace.workspaceFolders[0];
		if (workspaceFolder) {
			const folder = workspaceFolder.uri.fsPath;
			await toggleReplay(folder);
		}
	}

	async function next() {
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
	}

	async function nextEdit() {
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
				let idx = commits.indexOf(head);
				if (idx === -1) {
					throw new Error("BLARG");
				}
				let nextCommit: null | string = null;
				while (true) {
					idx++;
					if (idx >= commits.length) {
						break;
					}
					const commit = treeProvider.getTreeNodeForCommit(folder, commits[idx]);
					if (commit && !(commit.commit.changedFiles.length === 1 &&
						commit.commit.changedFiles[0].fileName === TERMINAL_DATA_FILE_NAME)) {
						nextCommit = commit.sha;
						break;
					}
					
				}
				if (nextCommit) {
					await doRestoreCommit(folder, nextCommit);
				}
			});
		}
	}

	async function previous() {
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
	}

	async function onChangeDocument(changeEvent: TextDocumentChangeEvent) {
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
	}

	async function onChangeActiveTextEditor(editor) {
		if (editor) {
			const filePath = editor.document.uri.fsPath;
			const folder = getWorkspaceFolder(filePath);
			if (folder) {
				await jobQueue.push(async () => {
					await doSave(folder);
				});
			}
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

	async function restore(node: CommitTreeNode) {
		if (!node) {
			window.showInformationMessage("Warning: no changed node for a restore");
			return;
		}
		await jobQueue.push(async () => doRestoreCommit(node.folder, node.sha));
	}

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
		const changedFiles = await getTop5ChangedFiles(workingDir, sha);
		if (changedFiles.length === 1 && changedFiles[0] !== TERMINAL_DATA_FILE_NAME) {
			window.showTextDocument(Uri.file(path.join(workingDir, changedFiles[0])));
		}
		const terminalDataFilePath = path.join(workingDir, TERMINAL_DATA_FILE_NAME);
		if (await fileExists(terminalDataFilePath)) {
			const terminalData = (await fs.readFile(terminalDataFilePath)).toString();
			terminalRenderer.write(terminalData);
		}
		const foundCommit = treeProvider.getTreeNodeForCommit(workingDir, sha);
		if (foundCommit) {
			treeView.reveal(foundCommit, { select: false });
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
			await refresh();
		}
		saveRefCount--;
	}

	async function refresh(): Promise<void> {
		await treeProvider.refresh();
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
