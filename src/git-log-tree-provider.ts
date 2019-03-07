import { TreeDataProvider, EventEmitter, Event, TreeItem, TreeItemCollapsibleState, Uri, ProviderResult } from "vscode";
import { Commit } from "./git-helpers";
import * as path from "path";
import { GitRepo, GitRepoState } from "./git-repo";
import { Subscription } from "rxjs";
import { findIndex, uniq, difference } from "lodash";

export class GitLogTreeProvider implements TreeDataProvider<Commit> {

	private changeEmitter: EventEmitter<Commit | undefined> = new EventEmitter<Commit | undefined>();
	readonly onDidChangeTreeData: Event<Commit | undefined | null> = this.changeEmitter.event;
	private repoState: GitRepoState;
	private _showSections: boolean = false;
	private subscription: Subscription;

	constructor(private repo: GitRepo, showSections: boolean) {
		this._showSections = showSections;
		this.subscription = this.repo.state$.subscribe((state) => {
			if (this.repoState) {
				// TODO: clean up
				const prevHead = this.repoState.head;
				const prevMasterHead = this.repoState.branchHead;
				const prevCommits = this.repoState.commits;
				const prevSectionStart = prevHead && this.repo.getSectionStart(prevHead);
				const newHead = state.head;
				const newMasterHead = state.branchHead;
				const newSectionStart = newHead && this.repo.getSectionStart(newHead);
				const shas: string[] = uniq([prevHead, prevMasterHead, newHead, newMasterHead, prevSectionStart, newSectionStart]) as string[];
				let commitsWithNewAnnotations: string[] = [];
				if (this.repoState.tags !== state.tags) {
					// tags changed: assume added
					const newTagNames = difference(Object.keys(state.tags), Object.keys(this.repoState.tags));
					commitsWithNewAnnotations = shas.concat((newTagNames.map(tagName => state.tags[tagName].commitSha)));
				}
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
					for (const commitSha of commitsWithNewAnnotations) {
						this.changeEmitter.fire(commits[commitSha]);
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

	public set showSections(show: boolean) {
		this._showSections = show;
		this.changeEmitter.fire(undefined);
	}

	public get showSections(): boolean {
		return this._showSections;
	}

	isLatest(commit: Commit): boolean {
		const { shas } = this.repoState;
		const idx = findIndex(shas, (sha) => sha === commit.sha);
		return idx === shas.length - 1;
	}

	isCurrent(commit: Commit): boolean {
		const { head } = this.repoState;
		return head && head === commit.sha || false;
	}

	public getTreeItem(node: Commit): TreeItem {
		console.log("get tree item for", node.sha, node.changeSummary);
		const item = new TreeItem(this.getCommitNodeDisplay(node), TreeItemCollapsibleState.None);
		if (this.showSections) {
			if (this.repo.isHeadInSection(node.sha)) {
				item.iconPath = Uri.file(path.join(__filename, "..", "..", "media", "current.svg"));
			}
		} else {
			if (this.repo.getAnnotation(node.sha)) {
				item.iconPath = Uri.file(path.join(__filename, "..", "..", "media", "section.svg"));
			}
			if (this.isLatest(node)) {
				item.iconPath = Uri.file(path.join(__filename, "..", "..", "media", "latest.svg"));
			}
			if (this.isCurrent(node)) {
				item.iconPath = Uri.file(path.join(__filename, "..", "..", "media", "current.svg"));
			}
		}
		item.id = node.sha;
		item.contextValue = "commit";
		return item;
	}

	public async getChildren(node?: Commit): Promise<Commit[]> {
		if (!node) {
			const commits = this.repoState.shas
				.map((sha) => this.repoState.commits[sha]);
			if (this.showSections) {
				return commits.filter((commit) => {
					return !!this.repo.getAnnotation(commit.sha);
				});
			} else {
				return commits;
			}
		} else {
			return [];
		}
	}

	public getParent(element: Commit): ProviderResult<Commit> {
		return null;
	}

	getCommitNodeDisplay(commit: Commit): string {
		let display;
		const annotation = this.repo.getAnnotation(commit.sha);
		if (annotation) {
			const commitCount = this.repo.getSectionCommitCount(commit.sha);
			if (this.repo.isHeadInSection(commit.sha)) {
				const stepNumber = this.repo.stepNumberOfHead(commit.sha);
				display = `${annotation} (${stepNumber} / ${commitCount})`;
			} else {
				display = `${annotation} (${commitCount})`;
			}
		} else if (commit.changedFiles.length === 1) {
			const file = commit.changedFiles[0];
			display = file.fileName + " | " + file.changeDetail;
		} else {
			display = commit.changeSummary || commit.message || commit.sha;
		}
		return display;
	}
}

