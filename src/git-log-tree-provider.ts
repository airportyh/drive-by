import { TreeDataProvider, EventEmitter, Event, TreeItem, TreeItemCollapsibleState, Uri, ProviderResult } from "vscode";
import { Commit } from "./git-helpers";
import * as path from "path";
import { GitRepo, GitRepoState } from "./git-repo";
import { Subscription } from "rxjs";
import { findIndex, uniq } from "lodash";

export class GitLogTreeProvider implements TreeDataProvider<Commit> {

	private changeEmitter: EventEmitter<Commit | undefined> = new EventEmitter<Commit | undefined>();
	readonly onDidChangeTreeData: Event<Commit | undefined | null> = this.changeEmitter.event;
	private repoState: GitRepoState;
	private subscription: Subscription;

	constructor(private repo: GitRepo) {
		this.subscription = this.repo.state$.subscribe((state) => {
			if (this.repoState) {
				// TODO: clean up
				const prevHead = this.repoState.head;
				const prevMasterHead = this.repoState.branchHead;
				const prevCommits = this.repoState.commits;
				const newHead = state.head;
				const newMasterHead = state.branchHead;
				const shas: string[] = uniq([prevHead, prevMasterHead, newHead, newMasterHead]) as string[];
				const hasNewCommit = shas.some((sha) =>
					!(sha in prevCommits)
				);
				this.repoState = state;
				if (!hasNewCommit) {
					const commits = shas
						.map((sha) => sha && this.repo.getCommit(sha));
					
					for (const commit of commits) {
						if (commit) {
							this.changeEmitter.fire(commit);
						}
					}
				} else {
					this.changeEmitter.fire(undefined);
				}
			} else {
				this.repoState = state;
				this.changeEmitter.fire(undefined);
			}
		});
	}

	public cleanup() {
		this.subscription.unsubscribe();
	}

	isLatest(change: Commit): boolean {
		const { shas } = this.repoState;
		const idx = findIndex(shas, (sha) => sha === change.sha);
		return idx === shas.length - 1;
	}

	isCurrent(change: Commit): boolean {
		const { head } = this.repoState;
		return head && head === change.sha || false;
	}

	public getTreeItem(node: Commit): TreeItem {
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
	}

	public async getChildren(node?: Commit): Promise<Commit[]> {
		if (!node) {
			const commits = this.repoState.shas
				.map((sha) => this.repoState.commits[sha]);
			return commits;
		} else {
			return [];
		}
	}

	public getParent(element: Commit): ProviderResult<Commit> {
		return null;
	}

	getChangeNodeDisplay(commit: Commit): string {
		let display;
		if (commit.changedFiles.length === 1) {
			const file = commit.changedFiles[0];
			display = file.fileName + " | " + file.changeDetail;
		} else {
			display = commit.changeSummary || commit.message || commit.sha;
		}
		return display;
	}
}

