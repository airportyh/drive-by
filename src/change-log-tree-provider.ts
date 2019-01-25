import { WorkspaceFolder, TreeDataProvider, EventEmitter, Event, TreeItem, TreeItemCollapsibleState, Uri, workspace, window } from "vscode";
import { getHead, getMasterChangeLog, getStatus, isGitInitialized, Commit } from "./git-helpers";
import * as path from "path";
import { debounce } from "lodash";

export type ChangeTreeNode = {
	type: "change",
	sha: string,
	commit: Commit,
	folder: string,
	isCurrent: boolean;
	isLatest: boolean;
	isModified: boolean;
};

type FolderTreeNode = {
	type: "folder", 
	folderName: string,
	folderPath: string
};

type TreeNode = ChangeTreeNode | FolderTreeNode;

export class ChangeLogTreeProvider implements TreeDataProvider<TreeNode> {

	private changeEmitter: EventEmitter<TreeNode | undefined> = new EventEmitter<TreeNode | undefined>();
	readonly onDidChangeTreeData: Event<TreeNode | undefined | null> = this.changeEmitter.event;
	private changesCache: _.Dictionary<ChangeTreeNode[]> = {};
	public refresh: () => Promise<void>;

	constructor() {
		this.refresh = debounce(() => this.doRefresh(), 250);
	}

	async doRefresh(): Promise<void> {
		for (let folder in this.changesCache) {
			await this.loadChangesForFolder(folder);
		}
		this.changeEmitter.fire();
	}

	getTreeItem(node: TreeNode): TreeItem {
		if (node.type === "change") {
			const item = new TreeItem(getChangeNodeDisplay(node), TreeItemCollapsibleState.None);
			if (node.isLatest) {
				item.iconPath = Uri.file(path.join(__filename, "..", "..", "media", "latest.svg"));
			}
			if (node.isCurrent) {
				item.iconPath = Uri.file(path.join(__filename, "..", "..", "media", "current.svg"));
			}
			item.contextValue = "change";
			return item;
		} else if (node.type === "folder") {
			return new TreeItem(node.folderName, TreeItemCollapsibleState.Expanded);
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
				return {
					type: "folder", 
					folderName: folder.name,
					folderPath: folder.uri.fsPath
				} as FolderTreeNode;
			});
		} else if (node.type === "folder") {
			await this.ensureChangesLoadedForFolder(node.folderPath);
			return this.changesCache[node.folderPath];
		} else if (node.type === "change") {
			return [];
		} else {
			return [];
		}
	}

	async ensureChangesLoadedForFolder(folder: string): Promise<void> {
		if (this.changesCache[folder]) {
			return;
		}
		await this.loadChangesForFolder(folder);
	}

	async loadChangesForFolder(folder: string): Promise<void> {
		let changes: ChangeTreeNode[] = [];
		if (await isGitInitialized(folder)) {
			const head = await getHead(folder);
			const commits = await getMasterChangeLog(folder);
			const status = await getStatus(folder);
			const modified = !!status.match(/modified\:/);
			const end = new Date().getTime();
			changes = commits.map((commit, idx) => {
				return {
					type: "change",
					sha: commit.sha,
					commit: commit,
					folder: folder,
					isCurrent: head === commit.sha,
					isLatest: idx === commits.length - 1,
					isModified: head === commit.sha && modified
				} as ChangeTreeNode;
			});
		} else {
			changes = [];
		}
		this.changesCache[folder] = changes;
	}
}

function getChangeNodeDisplay(node: ChangeTreeNode): string {
	let display;
	if (node.commit.changedFiles.length === 1) {
		const file = node.commit.changedFiles[0];
		display = file.fileName + " | " + file.changeDetail;
	} else {
		display = node.commit.changeSummary;
	}
	if (node.isModified) {
		display = "~" + display;
	}
	return display;
}