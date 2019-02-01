import { TreeDataProvider, EventEmitter, Event, TreeItem, TreeItemCollapsibleState, Uri, workspace, window } from "vscode";
import { getMasterChangeLog, isGitInitialized, Commit, getCommitShas, getCommit, getHead, getStatus } from "./git-helpers";
import * as path from "path";
import { debounce } from "lodash";
import { notEqual } from "assert";
import { JobQueue } from "./job-queue";

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
	private commitsCache: _.Dictionary<Commit[]> = {};
	private head: string | null = null;
	private status: string | null = null;
	public refresh: () => Promise<void>;

	constructor(private jobQueue: JobQueue) {
		this.refresh = debounce(() => this.doRefresh(), 250);
	}

	async doRefresh(): Promise<void> {
		for (let folder in this.commitsCache) {
			await this.loadChangesForFolder(folder);
		}
		this.changeEmitter.fire();
	}

	getTreeItem(node: TreeNode): TreeItem {
		if (node.type === "change") {
			const item = new TreeItem(this.getChangeNodeDisplay(node), TreeItemCollapsibleState.None);
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
			const folder = node.folderPath;
			const modified = this.status && !!this.status.match(/modified\:/);
			const commits =  this.commitsCache[folder];
			return commits.map((commit, idx) => {
				return {
					type: "change",
					sha: commit.sha,
					commit: commit,
					folder: folder,
					isCurrent: this.head && this.head === commit.sha,
					isLatest: idx === commits.length - 1,
					isModified: this.head && this.head === commit.sha && modified
				} as ChangeTreeNode;
			});
		} else if (node.type === "change") {
			return [];
		} else {
			return [];
		}
	}

	async ensureChangesLoadedForFolder(folder: string): Promise<void> {
		if (this.commitsCache[folder]) {
			return;
		}
		await this.loadChangesForFolder(folder);
	}

	async loadChangesForFolder(folder: string): Promise<void> {
		if (await isGitInitialized(folder)) {
			await this.jobQueue.push(async () => {
				this.head = await getHead(folder);
				this.status = await getStatus(folder);
				if (!this.commitsCache[folder]) {
					const commits = await getMasterChangeLog(folder)
					this.commitsCache[folder] = commits;
				} else {
				
					// only fetch the unfetched ones
					const shas = await getCommitShas(folder);
					const commits = this.commitsCache[folder];
					const existingCommitShas = commits.map(commit => commit.sha);
					const shasToFetch = shas.filter((sha) => {
						return existingCommitShas.indexOf(sha) === -1;
					});
					for (let sha of shasToFetch) {
						const commit = await getCommit(folder, sha);
						commits.push(commit);
					}
				
				}
			});
		} else {
			this.commitsCache[folder] = [];
		}
	}

	getChangeNodeDisplay(node: ChangeTreeNode): string {
		let display;
		if (node.commit.changedFiles.length === 1) {
			const file = node.commit.changedFiles[0];
			display = file.fileName + " | " + file.changeDetail;
		} else {
			display = node.commit.changeSummary || node.commit.message || node.sha;
		}
		if (node.isModified) {
			display = "~" + display;
		}
		return display;
	}
}

