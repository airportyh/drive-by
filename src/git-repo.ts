import { Commit, isGitInitialized, getHead, getStatus, getMasterChangeLog, getCommitShas, getCommit, hardReset, getMasterHead, initializeGitRepo, save, restoreToCommitSha, getBranchHead, getBranches, createBranch, checkoutBranch, restoreToBranch, getBranchChangeLog, Tag, getTags, getTag, createTag } from "./git-helpers";
import { BehaviorSubject, Observable } from "rxjs";
import { JobQueue } from "./job-queue";
import { findIndex, findLastIndex, keyBy, includes } from "lodash";

export type GitRepoState = {
    commits: _.Dictionary<Commit>;
    tags: _.Dictionary<Tag>;
    shas: string[];
    head: string | null;
    branchHead: string | null;
    branch: string;
};

export class GitRepo {
    
    subject$: BehaviorSubject<GitRepoState>;
    queue: JobQueue = new JobQueue();

    private constructor(private workingDir: string) {}

    public static async initialize(workingDir: string, branch: string): Promise<GitRepo> {
        const repo = new GitRepo(workingDir);
        await repo.initialize(branch);
        return repo;
    }

    public async initialize(branch: string): Promise<void> {
        await this.queue.push(async () => {
            const initialized = await isGitInitialized(this.workingDir);
            if (!initialized) {
                await initializeGitRepo(this.workingDir);
            }
            const branches = await getBranches(this.workingDir);
            if (!includes(branches, branch)) {
                await createBranch(this.workingDir, branch);
            } else {
                // TODO: maybe want to check if the current head is within
                // the path of the active branch, and if not, maybe switch
                // branch or prompt the user
                // await checkoutBranch(this.workingDir, this.branch);
            }
            
            const [head, branchHead, commits, tags] = await Promise.all([
                getHead(this.workingDir),
                getBranchHead(this.workingDir, branch),
                getBranchChangeLog(this.workingDir, branch),
                this.getTags()
            ]);
            this.subject$ = new BehaviorSubject({
                head,
                branchHead,
                branch,
                commits: keyBy(commits, "sha"),
                shas: commits && commits.map((commit) => commit.sha) || [],
                tags: keyBy(tags, "commitSha")
            });
        });
    }

    public async getTags(): Promise<Tag[]> {
        const tagNames = await getTags(this.workingDir);
        const tags: Tag[] = [];
        for (let tagName of tagNames) {
            const tag = await getTag(this.workingDir, tagName);
            if (tag) {
                tags.push(tag);
            }
        }
        return tags;
    }

    public getCommit(sha: string): Commit | undefined {
        return this.state.commits[sha];
    }

    public getSectionCommitCount(sha: string): number {
        const annotation = this.getAnnotation(sha);
        if (!annotation) {
            return 0;
        }
        const startIdx = this.state.shas.indexOf(sha);
        if (startIdx === -1) {
            return 0;
        }
        const nextSectionStartIdx = findIndex(this.state.shas, (sha) => !!this.getAnnotation(sha), startIdx + 1);
        if (nextSectionStartIdx === -1) {
            return this.state.shas.length - startIdx;
        } else {
            return nextSectionStartIdx - startIdx;
        }
    }

    public stepNumberOfHead(sectionSha: string): number {
        if (!this.state.head) {
            return 0;
        }
        const sectionIdx = this.state.shas.indexOf(sectionSha);
        const headIdx = this.state.shas.indexOf(this.state.head);
        return headIdx - sectionIdx + 1;
    }

    public isHeadInSection(sha: string): boolean {
        const annotation = this.getAnnotation(sha);
        if (!annotation) {
            return false;
        }
        const startIdx = this.state.shas.indexOf(sha);
        if (startIdx === -1) {
            return false;
        }
        const head = this.state.head;
        if (!head) {
            return false;
        }
        const headIdx = this.state.shas.indexOf(head);
        const nextSectionStartIdx = findIndex(this.state.shas, (sha) => !!this.getAnnotation(sha), startIdx + 1);
        if (nextSectionStartIdx === -1) {
            return this.state.shas.length > headIdx && headIdx >= startIdx;
        } else {
            return nextSectionStartIdx > headIdx && headIdx >= startIdx;
        }
    }

    public getSectionStart(sha: string): string | null {
        const idx = this.state.shas.indexOf(sha);
        const prevSectionStartIdx = findLastIndex(this.state.shas, 
            (sha) => !!this.getAnnotation(sha), idx);
        if (prevSectionStartIdx === -1) {
            return null;
        } else {
            return this.state.shas[prevSectionStartIdx];
        }
    }

    public getAnnotation(commitSha: string): string | undefined {
        const tag = this.state.tags[commitSha];
        if (tag) {
            return tag.annotation;
        }
    }

    public async createAnnotation(commitSha: string, annotation: string): Promise<void> {
        const tagName = this.createSlug(annotation);
        await createTag(this.workingDir, tagName, commitSha, annotation);
        const tag = await getTag(this.workingDir, tagName);
        if (!tag) {
            throw new Error("BLARGH");
        }
        this.subject$.next({
            ...this.state,
            tags: {
                ...this.state.tags,
                [commitSha]: tag
            }
        })
    }

    public async restoreCommit(sha: string): Promise<void> {
        await this.queue.push(async () => {
            if (this.state.branchHead === sha) {
                await restoreToBranch(this.workingDir, this.state.branch);
            } else {
                await restoreToCommitSha(this.workingDir, sha);
            }
            this.subject$.next({
                ...this.state,
                head: sha
            });
        });
    }

    public async restoreToPreviousCommit(): Promise<void> {
        await this.queue.push(async () => {
            const head = this.state.head;
            if (!head) {
                return;
            }
            const shas = this.state.shas;
            const idx = shas.indexOf(head);
            if (idx === -1) {
                throw new Error("BLARG");
            }
            if (idx - 1 >= 0) {
                const previousSha = shas[idx - 1];
                await this.restoreCommit(previousSha);
            }
        });
    }

    public async restoreToNextCommit(): Promise<void> {
        await this.queue.push(async () => {
            const head = this.state.head;
            if (!head) {
                return;
            }
            const shas = this.state.shas;
            const idx = shas.indexOf(head);
            if (idx === -1) {
                throw new Error("BLARG");
            }
            if (idx + 1 < shas.length) {
                const nextSha = shas[idx + 1];
                await this.restoreCommit(nextSha);
            }
        });
    }

    public async save(beforeSave?: () => Promise<void>) {
        await this.queue.push(async () => {
            const branchHead = this.state.branchHead;
            const head = this.state.head;
            if (branchHead === head) {
                if (beforeSave) {
                    await beforeSave();
                }
                const saved = await save(this.workingDir);
                if (!saved) {
                    return;
                }
                const head = await getBranchHead(this.workingDir, this.state.branch);
                if (!head) {
                    throw new Error("BLARGH");
                }
                const newCommit = await getCommit(this.workingDir, head);
                const newState = {
                    commits: {
                        ...this.state.commits,
                        [newCommit.sha]: newCommit
                    },
                    shas: [...this.state.shas, head],
                    head: head,
                    branchHead: head,
                    tags: this.state.tags,
                    branch: this.state.branch
                };
                this.subject$.next(newState);
            }
        });
    }

    public get head(): string | null {
        return this.state.head;
    }

    public async branchFrom(commitSha: string, newBranch: string): Promise<void> {
        await restoreToCommitSha(this.workingDir, commitSha);
        await createBranch(this.workingDir, newBranch);
        const idx = this.state.shas.indexOf(commitSha);
        const newShas = this.state.shas.slice(0, idx + 1);
        const newState = {
            commits: this.state.commits,
            shas: newShas,
            head: commitSha,
            branchHead: commitSha,
            tags: this.state.tags,
            branch: newBranch
        };
        this.subject$.next(newState);
    }

    public async switchBranch(branch: string): Promise<void> {
        await checkoutBranch(this.workingDir, branch);
        const shas = await getCommitShas(this.workingDir, branch);
        const shasToFetch = shas.filter((sha) => !(sha in this.state.commits));
        const newCommits = await Promise.all(
            shasToFetch.map((sha) => getCommit(this.workingDir, sha)));
        const branchHead = await getBranchHead(this.workingDir, branch);
        const newState = {
            commits: {
                ...this.state.commits,
                ...keyBy(newCommits, "sha")
            },
            shas,
            head: branchHead,
            branchHead,
            tags: this.state.tags,
            branch
        };
        this.subject$.next(newState);
    }

    public async revertToCommit(commitSha: string): Promise<void> {
        await checkoutBranch(this.workingDir, this.state.branch);
        await hardReset(this.workingDir, commitSha);
        const idx = this.state.shas.indexOf(commitSha);
        const newShas = this.state.shas.slice(0, idx + 1);
        const newState = {
            ...this.state,
            shas: newShas,
            head: commitSha,
            branchHead: commitSha
        };
        this.subject$.next(newState);
    }

    createSlug(message: string): string {
        return message.toLowerCase().split(/[^a-z0-9]/g).filter(part => !!part).join("-");
    }

    async getModified(): Promise<boolean> {
        const status = await getStatus(this.workingDir);
        return status && !!status.match(/modified\:/) || false;
    }

    get state$(): Observable<GitRepoState> {
        return this.subject$;
    }

    get state(): GitRepoState {
        return this.subject$.value;
    }

}