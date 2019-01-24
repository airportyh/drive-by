import { WorkspaceFolder, TreeDataProvider, EventEmitter, Event, TreeItem, TreeItemCollapsibleState, Uri, workspace } from "vscode";
import { getHead, getMasterChangeLog, getStatus, isGitInitialized } from "./git-helpers";
import * as path from "path";
import { directoryExists } from "./fs-helpers";

export type ChangeTreeNode = {
	type: "change",
	sha: string,
	folder: FolderTreeNode,
	isCurrent: boolean;
	isLatest: boolean;
	isModified: boolean;
};

type FolderTreeNode = {
	type: "folder", 
	folder: WorkspaceFolder
};

type TreeNode = ChangeTreeNode | FolderTreeNode;

export class ChangeLogTreeProvider implements TreeDataProvider<TreeNode> {

	private changeEmitter: EventEmitter<TreeNode | undefined> = new EventEmitter<TreeNode | undefined>();
	readonly onDidChangeTreeData: Event<TreeNode | undefined | null> = this.changeEmitter.event;
	
	refresh(): void {
		this.changeEmitter.fire();
	}

	getTreeItem(node: TreeNode): TreeItem {
		if (node.type === "change") {
			const label = (node.isModified ? "~": "") + node.sha.substr(0, 7);
			const item = new TreeItem(label, TreeItemCollapsibleState.None);
			if (node.isLatest) {
				item.iconPath = Uri.file(path.join(__filename, "..", "..", "media", "latest.svg"));
			}
			if (node.isCurrent) {
				item.iconPath = Uri.file(path.join(__filename, "..", "..", "media", "current.svg"));
			}
			item.contextValue = "change";
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
				return <TreeNode>{ type: "folder", folder };
			});
		} else if (node.type === "folder") {
			const folder = node.folder.uri.fsPath;
			if (await isGitInitialized(folder)) {
				const head = await getHead(folder);
				const commits = await getMasterChangeLog(folder);
				const status = await getStatus(folder);
				const modified = !!status.match(/modified\:/);
				return commits.map((commit, idx) => {
					return <ChangeTreeNode>{
						type: "change",
						sha: commit,
						folder: node,
						isCurrent: head === commit,
						isLatest: idx === commits.length - 1,
						isModified: head === commit && modified
					};
				});
			} else {
				return [];
			}
		} else if (node.type === "change") {
			return [];
		} else {
			return [];
		}
	}
}