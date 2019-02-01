import { TreeDataProvider, EventEmitter, Event, TreeItem, TreeItemCollapsibleState, Uri, workspace, window, ProviderResult } from "vscode";
import { getMasterChangeLog, isGitInitialized, Commit, getCommitShas, getCommit, getHead, getStatus } from "./git-helpers";
import * as path from "path";
import { debounce, find, findIndex } from "lodash";
import { JobQueue } from "./job-queue";

export type CommitTreeNode = {
	type: "commit",
	sha: string,
	commit: Commit,
	folder: string
};

type FolderTreeNode = {
	type: "folder", 
	folderName: string,
	folderPath: string
};

type GitDirectoryState = {
	commits: CommitTreeNode[],
	head: string | null,
	status: string | null
}

type TreeNode = CommitTreeNode | FolderTreeNode;

export class ChangeLogTreeProvider implements TreeDataProvider<TreeNode> {

	private changeEmitter: EventEmitter<TreeNode | undefined> = new EventEmitter<TreeNode | undefined>();
	readonly onDidChangeTreeData: Event<TreeNode | undefined | null> = this.changeEmitter.event;
	private commitsCache: _.Dictionary<GitDirectoryState> = {};
	public refresh: () => Promise<void>;

	constructor(private jobQueue: JobQueue) {
		this.refresh = () => this.doRefresh();
	}

	async doRefresh(): Promise<void> {
		for (let folder in this.commitsCache) {
			await this.loadChangesForFolder(folder);
		}
	}

	isModified(change: CommitTreeNode): boolean {
		const { status, head } = this.commitsCache[change.folder];
		const modified = status && !!status.match(/modified\:/);
		return head && head === change.sha && modified || false;
	}

	isLatest(change: CommitTreeNode): boolean {
		const { commits } = this.commitsCache[change.folder];
		const idx = findIndex(commits, (commit) => commit.sha === change.sha);
		return idx === commits.length - 1;
	}

	isCurrent(change: CommitTreeNode): boolean {
		const { head } = this.commitsCache[change.folder];
		return head && head === change.sha || false;
	}

	public getTreeItem(node: TreeNode): TreeItem {
		if (node.type === "commit") {
			const item = new TreeItem(this.getChangeNodeDisplay(node), TreeItemCollapsibleState.None);
			if (this.isLatest(node)) {
				item.iconPath = Uri.file(path.join(__filename, "..", "..", "media", "latest.svg"));
			}
			if (this.isCurrent(node)) {
				item.iconPath = Uri.file(path.join(__filename, "..", "..", "media", "current.svg"));
			}
			item.id = node.sha;
			item.contextValue = "change";
			return item;
		} else if (node.type === "folder") {
			const item = new TreeItem(node.folderName, TreeItemCollapsibleState.Expanded);
			item.id = node.folderPath;
			return item;
		} else {
			throw new Error("Unknown node type: " + node["type"]);
		}
	}

	public async getChildren(node?: TreeNode): Promise<TreeNode[]> {
		if (!node) {
			return this.getFolderNodes();
		} else if (node.type === "folder") {
			await this.ensureChangesLoadedForFolder(node.folderPath);
			const folder = node.folderPath;
			return this.commitsCache[folder].commits;
		} else if (node.type === "commit") {
			return [];
		} else {
			return [];
		}
	}

	public getParent(element: TreeNode): ProviderResult<TreeNode> {
		if (element.type === "commit") {
			return find(this.getFolderNodes(), 
				(folder) => folder.folderPath === element.folder);
		} else if (element.type === "folder") {
			return null;
		}
	}

	getFolderNodes(): FolderTreeNode[] {
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
	}

	getTreeNodeForCommit(folder: string, sha: string): CommitTreeNode | null {
		const { commits } = this.commitsCache[folder];
		return find(commits, (commit) => commit.sha === sha) || null;
	}

	commitAsTreeNode(folder: string, commit: Commit): CommitTreeNode {
		return {
			type: "commit",
			sha: commit.sha,
			commit: commit,
			folder
		};
	}

	async ensureChangesLoadedForFolder(folder: string): Promise<void> {
		if (this.commitsCache[folder]) {
			return;
		}
		await this.loadChangesForFolder(folder);
	}

	async loadChangesForFolder(folder: string): Promise<void> {
		if (await isGitInitialized(folder)) {
			if (!this.commitsCache[folder]) {
				await this.jobQueue.push(() => this.fullUpdate(folder));
			} else {
				await this.jobQueue.push(() => this.incrementalUpdate(folder));
			}
		} else {
			this.commitsCache[folder] = {
				head: null,
				status: null,
				commits: []
			}
		}
	}

	async fullUpdate(folder: string): Promise<void> {
		const [head, status, commits] = await Promise.all([
			getHead(folder),
			getStatus(folder),
			getMasterChangeLog(folder)
				.then((commits) => commits
					.map((commit) => 
						this.commitAsTreeNode(folder, commit)))
		]);
		this.commitsCache[folder] = {
			head,
			status,
			commits
		};
		const folderNode = this.getFolderNode(folder);
		if (folderNode) {
			this.changeEmitter.fire(folderNode);
		}
	}

	getFolderNode(folder: string): FolderTreeNode | null {
		return find(this.getFolderNodes(), 
			(folderNode) => folderNode.folderPath === folder) || null;

	}

	async incrementalUpdate(folder: string): Promise<void> {
		const [head, status, shas] = await Promise.all([
			getHead(folder),
			getStatus(folder),
			// only fetch the unfetched ones
			getCommitShas(folder)
		]);
		const directoryState = this.commitsCache[folder];
		let prevCurrentCommit: null | CommitTreeNode = null;
		const headChanged = directoryState.head !== head;
		if (directoryState.head && directoryState.head !== head) {
			prevCurrentCommit = this.getTreeNodeForCommit(folder, directoryState.head);
			if (prevCurrentCommit) {
				this.changeEmitter.fire(prevCurrentCommit);
			}
		}
		directoryState.head = head;
		directoryState.status = status;
		if (head && headChanged) {
			const currentCommit = this.getTreeNodeForCommit(folder, head);
			if (currentCommit) {
				this.changeEmitter.fire(currentCommit);
			}
		}
		const commits = directoryState.commits;
		const existingCommitShas = commits.map(commit => commit.sha);
		const shasToFetch = shas.filter((sha) => {
			return existingCommitShas.indexOf(sha) === -1;
		});
		for (let sha of shasToFetch) {
			const commit = await getCommit(folder, sha);
			const commitNode = this.commitAsTreeNode(folder, commit);
			commits.push(commitNode);
		}
		if (shasToFetch.length > 0) {
			const folderNode = this.getFolderNode(folder);
			if (folderNode) {
				this.changeEmitter.fire(folderNode);
			}
		}
	}

	getChangeNodeDisplay(node: CommitTreeNode): string {
		let display;
		if (node.commit.changedFiles.length === 1) {
			const file = node.commit.changedFiles[0];
			display = file.fileName + " | " + file.changeDetail;
		} else {
			display = node.commit.changeSummary || node.commit.message || node.sha;
		}
		if (this.isModified(node)) {
			display = "~" + display;
		}
		return display;
	}
}

