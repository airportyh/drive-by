import { Commit, isGitInitialized, getHead, getStatus, getMasterChangeLog, getCommitShas, getCommit, reset, getMasterHead, initializeGitRepo, save, restoreToHead, restoreToCommitSha } from "./git-helpers";
import _ = require("lodash");
import { BehaviorSubject, Observable, ReplaySubject } from "rxjs";
import { map } from "rxjs/operators";
import { set } from "lodash/fp";
import { JobQueue } from "./job-queue";

export type GitRepoState = {
    commits: _.Dictionary<Commit>;
    shas: string[];
    head: string | null;
    masterHead: string | null;
    workingDirModified: boolean;
};

export class GitRepo {
    
    subject$: BehaviorSubject<GitRepoState>;
    queue: JobQueue = new JobQueue();

    private constructor(private workingDir: string) {}

    public static async initialize(workingDir: string): Promise<GitRepo> {
        const repo = new GitRepo(workingDir);
        await repo.initialize();
        return repo;
    }

    public async initialize(): Promise<void> {
        await this.queue.push(async () => {
            const initialized = await isGitInitialized(this.workingDir);
            if (!initialized) {
                await initializeGitRepo(this.workingDir);
            }
            
            const [head, masterHead, workingDirModified, commits] = await Promise.all([
                getHead(this.workingDir),
                getMasterHead(this.workingDir),
                this.getModified(),
                getMasterChangeLog(this.workingDir)
            ]);
            this.subject$ = new BehaviorSubject({
                head,
                masterHead,
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
            if (this.state.head === sha) {
                await restoreToHead(this.workingDir);
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
            const masterHead = this.state.masterHead;
            const head = this.state.head;
            if (masterHead === head) {
                if (beforeSave) {
                    await beforeSave();
                }
                const saved = await save(this.workingDir);
                if (!saved) {
                    return;
                }
                const head = await getMasterHead(this.workingDir);
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
                    masterHead: head,
                    workingDirModified: false
                };
                this.subject$.next(newState);
            }
        });
    }

    public get head(): string | null {
        return this.state.head;
    }
    
    // async incrementalUpdate(folder: string): Promise<void> {
    //     await this.queue.push(async () => {
    //         const [head, status, shas] = await Promise.all([
    //             getHead(folder),
    //             getStatus(folder),
    //             getCommitShas(folder)
    //         ]);
    //         this.setHead(head);
    //         this.setStatus(status);
    //         // TODO notify of status changes
    //         // Usually there should be only 1 new commit, not bothering
    //         // to parallelize.
    //         const commits = this.subject$.value.commits;
    //         const shasToFetch = shas.filter((sha) => !(sha in commits));
    //         for (let sha of shasToFetch) {
    //             const commit = await getCommit(folder, sha);
    //             this.addCommit(commit);
    //         }
    //     });
    // }

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