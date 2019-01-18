import { TreeDataProvider, TreeItem, WorkspaceFolder, Event, window, commands, workspace, EventEmitter, ExtensionContext, TreeItemCollapsibleState, TextDocumentChangeEvent, Uri } from 'vscode';
import * as moment from "moment";
import * as path from "path";
import { fs } from "mz";
import { Change, ChangeTracker } from './change-tracker';
import { find, debounce } from "lodash";

type ChangeTreeNode = {
	type: "change",
	change: Change,
	folder: FolderTreeNode,
	isCurrent: boolean;
	isLatest: boolean;
};

type FolderTreeNode = {
	type: "folder", 
	folder: WorkspaceFolder
};

type TreeNode = 
ChangeTreeNode |
FolderTreeNode;

class RCSProvider {

	private rcsDict: _.Dictionary<MyRCS> = {};
	async getRCS(folderPath: string): Promise<MyRCS> {
		if (!(folderPath in this.rcsDict)) {
			const rcs = this.rcsDict[folderPath] = new MyRCS(folderPath);
			await rcs.initialize();
		}
		return this.rcsDict[folderPath];
	}
}

type Job = () => Promise<void>;

class MyRCS {

	private tracker: ChangeTracker;
	private changes: _.Dictionary<Change> = {};
	private queue: Job[] = [];
	private isQueueRunning = false;
	constructor(private rootDir: string) {
		this.tracker = new ChangeTracker(this.rootDir);
	}

	async initialize(): Promise<void> {
		await this.tracker.initialize();
	}

	async getChangeLog(): Promise<Change[]> {
		await this.loadChanges();
		const root = await this.getRoot();
		return root && this.followChange(root) || [];
	}

	async getRoot(): Promise<Change | null> {
		await this.loadChanges();
		return find(this.changes, (change) => !change.parentSha) || null;
	}

	followChange(change: Change): Change[] {
		const childChange = find(this.changes, chg => 
			chg.parentSha === change.sha);
		if (!childChange) {
			return [change];
		}
		return [change, ...this.followChange(childChange)];
	}

	async getCurrentSha(): Promise<string | null> {
		return this.tracker.fetchCurrentSha();
	}

	async getLatestSha(): Promise<string | null> {
		const changes = await this.getChangeLog();
		const latest = changes[changes.length - 1] || null;
		return latest && latest.sha;
	}

	async loadChanges(): Promise<void> {
		const changesDirPath = path.join(this.rootDir, ".my-rcs", "changes");
		const entries = await fs.readdir(changesDirPath);
		for (let sha of entries) {
			if (!(sha in this.changes)) {
				const change: Change = await this.tracker.fetchChange(sha);
				this.changes[sha] = change;
			}
		}
	}

	async getChangedFile(sha: string): Promise<string | null> {
		return this.tracker.getChangedFile(sha);
	}

	async restoreChange(sha: string): Promise<void> {
		await this.processJob(() => this.tracker.restoreChange(sha));
	}

	async pushChange(filePath: string, content: string): Promise<void> {
		await this.processJob(async () => {
			await this.tracker.pushChange(filePath, content)
		});
	}

	async processJob(job: Job): Promise<void> {
		this.queue.push(job);
		await this.ensureQueueIsRunningAndProcessRemainingJobs();
	}

	async ensureQueueIsRunningAndProcessRemainingJobs(): Promise<void> {
		if (this.isQueueRunning) {
			return;
		}
		this.isQueueRunning = true;
		while (this.queue.length > 0) {
			const job = this.queue.pop();
			if (job) {
				await job();
			}
		}
		this.isQueueRunning = false;
	}

}

function folderPath(folder: FolderTreeNode): string {
	return folder.folder.uri.fsPath;
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

class SessionHistoryTreeProvider implements TreeDataProvider<TreeNode> {

	private changeEmitter: EventEmitter<TreeNode | undefined> = new EventEmitter<TreeNode | undefined>();
	readonly onDidChangeTreeData: Event<TreeNode | undefined | null> = this.changeEmitter.event;
	
	constructor(private rcsProvider: RCSProvider) {}

	refresh(): void {
		this.changeEmitter.fire();
	}

	getTreeItem(node: TreeNode): TreeItem {
		if (node.type === "change") {
			const label = moment(node.change.timestamp).calendar() + 
			" - " + node.change.sha.substring(0, 6) + "...";
			const item = new TreeItem(label,
				TreeItemCollapsibleState.None);
			if (node.isLatest) {
				item.iconPath = Uri.file(path.join(__filename, "..", "..", "media", "latest.svg"));
			}
			if (node.isCurrent) {
				item.iconPath = Uri.file(path.join(__filename, "..", "..", "media", "current.svg"));
			}
			return item;
		} else if (node.type === "folder") {
			return new TreeItem(node.folder.name, TreeItemCollapsibleState.Expanded);
		} else {
			throw new Error("Unknown node type: " + node["type"]);
		}
	}

	async getChildren(node?: TreeNode): Promise<TreeNode[]> {
		if (!node) {
			const folders = workspace.workspaceFolders;
			if (!folders) {
				return [];
			}
			return folders.map((folder) => {
				return { type: "folder", folder } as TreeNode;
			});
		} else if (node.type === "folder") {
			const rcs = await this.rcsProvider.getRCS(folderPath(node));
			const changeLog = await rcs.getChangeLog();
			const latest = await rcs.getLatestSha();
			const current = await rcs.getCurrentSha();
			return changeLog.map((change) => {
				return <ChangeTreeNode>{
					type: "change",
					isCurrent: change.sha === current,
					isLatest: change.sha === latest,
					change: change,
					folder: node
				};
			});
		} else if (node.type === "change") {
			return [];
		} else {
			return [];
		}
	}
}

export function activate(context: ExtensionContext) {
	const rcsProvider: RCSProvider = new RCSProvider();
	const sessionHistoryTreeProvider = new SessionHistoryTreeProvider(rcsProvider);
	window.registerTreeDataProvider("session-history", sessionHistoryTreeProvider);
	commands.registerCommand("driveBy.refresh", () => {
		sessionHistoryTreeProvider.refresh();
	});

	commands.registerCommand("driveBy.restore", async (node: ChangeTreeNode) => {
		const rcs = await rcsProvider.getRCS(folderPath(node.folder));
		await rcs.restoreChange(node.change.sha);
		const filePath = await rcs.getChangedFile(node.change.sha);
		if (filePath) {
			const uri = Uri.file(path.join(folderPath(node.folder), filePath))
			window.showTextDocument(uri);
		}
		sessionHistoryTreeProvider.refresh();
	});

	workspace.onDidChangeWorkspaceFolders(() => {
		sessionHistoryTreeProvider.refresh();
	});

	const onChange = debounce(async (changeEvent: TextDocumentChangeEvent) => {
		if (changeEvent) {
			if (changeEvent.contentChanges.length === 0) {
				return;
			}
			
			const workspaceFolder = getWorkspaceFolder(changeEvent.document.fileName);
			if (workspaceFolder) {
				await changeEvent.document.save();
				const filename = changeEvent.document.fileName;
				const content = changeEvent.document.getText();
				const rcs = await rcsProvider.getRCS(workspaceFolder);
				const currentSha = await rcs.getCurrentSha();
				const latest = await rcs.getLatestSha();
				console.log("current:", currentSha, "latest:", latest);
				if (currentSha === latest) {
					if (filename.indexOf(workspaceFolder) !== 0) {
						throw new Error("BLARGH");
					}
					const relativeFilename = filename.substring(workspaceFolder.length + 1);
					await rcs.pushChange(relativeFilename, content);
					sessionHistoryTreeProvider.refresh();
					console.log("saved change.")
				} else {
					console.log("did not save change.");
				}
			} else {
				window.showInformationMessage("Could not find workspace folder for " + 
					changeEvent.document.fileName);
			}
		} else {
			throw new Error("BLARGH");
		}
	}, 300);

	workspace.onDidChangeTextDocument(onChange);
}

export function deactivate() {}
