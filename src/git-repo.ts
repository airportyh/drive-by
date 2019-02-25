import { Commit, isGitInitialized, getHead, getStatus, getMasterChangeLog, getCommitShas, getCommit, reset, getMasterHead, initializeGitRepo, save, restoreToCommitSha, getBranchHead, getBranches, createBranch, checkoutBranch, restoreToBranch, getBranchChangeLog } from "./git-helpers";
import _ = require("lodash");
import { BehaviorSubject, Observable } from "rxjs";
import { JobQueue } from "./job-queue";

export type GitRepoState = {
    commits: _.Dictionary<Commit>;
    shas: string[];
    head: string | null;
    branchHead: string | null;
    workingDirModified: boolean;
};

export class GitRepo {
    
    subject$: BehaviorSubject<GitRepoState>;
    queue: JobQueue = new JobQueue();

    private constructor(private workingDir: string, private branch: string) {}

    public static async initialize(workingDir: string, branch: string): Promise<GitRepo> {
        const repo = new GitRepo(workingDir, branch);
        await repo.initialize();
        return repo;
    }

    public async initialize(): Promise<void> {
        await this.queue.push(async () => {
            const initialized = await isGitInitialized(this.workingDir);
            if (!initialized) {
                await initializeGitRepo(this.workingDir);
            }
            const branches = await getBranches(this.workingDir);
            if (!_.includes(branches, this.branch)) {
                await createBranch(this.workingDir, this.branch);
            } else {
                await checkoutBranch(this.workingDir, this.branch);
            }
            
            const [head, branchHead, workingDirModified, commits] = await Promise.all([
                getHead(this.workingDir),
                getBranchHead(this.workingDir, this.branch),
                this.getModified(),
                getBranchChangeLog(this.workingDir, this.branch)
            ]);
            this.subject$ = new BehaviorSubject({
                head,
                branchHead,
                workingDirModified,
                commits: _.keyBy(commits, "sha"),
                shas: commits && commits.map((commit) => commit.sha) || []
            });
        });
    }

    public getCommit(sha: string): Commit | undefined {
        return this.state.commits[sha];
    }

    public async restoreCommit(sha: string): Promise<void> {
        await this.queue.push(async () => {
            if (this.state.branchHead === sha) {
                await restoreToBranch(this.workingDir, this.branch);
            } else {
                await restoreToCommitSha(this.workingDir, sha);
            }
            this.subject$.next({
                ...this.state,
                workingDirModified: false,
                head: sha
            });
        });
    }

    public async revertToPreviousCommit(): Promise<void> {
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

    public async advanceToNextCommit(): Promise<void> {
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
                const head = await getBranchHead(this.workingDir, this.branch);
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
                    workingDirModified: false
                };
                this.subject$.next(newState);
            }
        });
    }

    public get head(): string | null {
        return this.state.head;
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