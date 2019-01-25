// TODO: https://stackoverflow.com/questions/1386291/git-git-dir-not-working-as-expected

import { workspace, ExtensionContext, TextDocumentChangeEvent, window, commands, TreeDataProvider, WorkspaceFolder, EventEmitter, Event, TreeItem, TreeItemCollapsibleState, Uri } from 'vscode';
import { debounce } from "lodash";
import { getHead, getMasterChangeLog, getStatus, getMasterHead, reset, restoreToHead, restoreCommit, save, isGitInitialized, ensureGitInitialized, getChangedFiles } from "./git-helpers";
import { ChangeLogTreeProvider, ChangeTreeNode } from './change-log-tree-provider';
import { delay } from './delay';
import { JobQueue } from './job-queue';
import * as path from "path";

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
	const jobQueue = new JobQueue();
	const treeProvider = new ChangeLogTreeProvider();
	let state: string = "idle";
	window.registerTreeDataProvider("driveBy", treeProvider);
	commands.registerCommand("driveBy.refresh", errorHandler(() => {
		refresh();
	}));

	commands.registerCommand("driveBy.restore", asyncErrorHandler(async(node: ChangeTreeNode) => {
		if (!node) {
			window.showInformationMessage("Warning: no changed node for a restore");
			return;
		}
		const folder = node.folder;
		jobQueue.push(async () => {
			doRestoreCommit(folder, node.sha);
		});
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
			jobQueue.push(async () => {
				const head = await getHead(folder);
				if (!head) {
					return;
				}
				const commits = (await getMasterChangeLog(folder))
					.map((commit) => commit.sha);
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
			jobQueue.push(async () => {
				const head = await getHead(folder);
				if (!head) {
					return;
				}
				const commits = (await getMasterChangeLog(folder))
					.map((commit) => commit.sha);
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
				jobQueue.push(async () => {
					await document.save();
					await doSave(folder);
				});
			} else {
				window.showInformationMessage("No workspace found.");
			}
		} else {
			throw new Error("BLARGH");
		}
	}), 500);

	async function doSave(workingDir: string) {
		const gitInitialized = await isGitInitialized(workingDir);
		if (!gitInitialized) {
			await ensureGitInitialized(workingDir);
		}
		const masterHead = await getMasterHead(workingDir);
		const head = await getHead(workingDir);
		
		if (masterHead === head) {
			await save(workingDir);
		}
		refresh();
	}

	

	workspace.onDidChangeTextDocument(onChange);
	window.onDidChangeActiveTextEditor((editor) => {
		if (editor) {
			const filePath = editor.document.uri.fsPath;
			const folder = getWorkspaceFolder(filePath);
			if (folder) {
				jobQueue.push(() => doSave(folder));
			}
		}
	});

	async function toggleReplay(folder: string) {
		if (state === "replay") {
			state = "idle";
		} else {
			jobQueue.push(() => replay(folder));
		}
	}

	async function replay(folder: string) {
		const head = await getHead(folder);
		if (!head) {
			return;
		}
		const commits = (await getMasterChangeLog(folder))
			.map((commit) => commit.sha);
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
		const head = await getMasterHead(workingDir);
		await restoreCommit(workingDir, sha);
		refresh();
		const changedFiles = await getChangedFiles(workingDir, sha);
		if (changedFiles.length === 1) {
			window.showTextDocument(Uri.file(path.join(workingDir, changedFiles[0])));
		}
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
