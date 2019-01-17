const sha1 = require("sha1");
const mkdirp = require("mkdirp-promise");
import * as path from "path";
import * as fs from "mz/fs";
import { difference } from "lodash";
import * as rmfr from "rmfr";

// Reference: https://blog.thoughtram.io/git/2014/11/18/the-anatomy-of-a-git-commit.html#whats-up-with-those-long-revision-names
// https://git-scm.com/book/en/v2/Git-Internals-Git-References

export async function fileExists(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath, fs["F_OK"]);
        return true;
    } catch (e) {
        return false;
    }
}

// A change is like a commit in git
export interface Change {
    sha: string;
    timestamp: Date;
    rootTreeSha: string;
    parentSha: string | null;
}

// A tree is like a tree in git
export interface Tree {
    [entryName: string]: TreeEntry;
};

// A tree-entry is either a pointer to another tree, or a file blob
export interface TreeEntry {
    type: "tree" | "blob";
    sha: string;
}

export async function createTracker(rootDir: string): Promise<ChangeTracker> {
    const tracker = new ChangeTracker(rootDir);
    await tracker.initialize();
    return tracker;
}

export class ChangeTracker {
    constructor(private rootDir: string) { }

    public async initialize(): Promise<void> {
        await mkdirp(this.rootDir);
        await mkdirp(this.metadataDir);
        await mkdirp(this.changesDir);
        await mkdirp(this.treesDir);
        await mkdirp(this.blobsDir);
        await mkdirp(this.refsDir);
    }

    public async pushChange(filePath: string, fileContent: string): Promise<string | null> {
        let parent: string | null;
        if (!await fileExists(this.currentRefPath)) {
            parent = null;
        } else {
            parent = await this.fetchCurrentSha();
        }
        const changeSha = await this.pushChangeOnParent(parent, filePath, fileContent);
        if (changeSha) {
            await fs.writeFile(this.currentRefPath, changeSha);
            return changeSha;
        } else {
            return null;
        }
    }

    public async pushChangeOnParent(
        parentSha: string | null, 
        filePath: string, 
        fileContent: string
    ): Promise<string | null> {
        let parentTreeSha;
        if (parentSha) {
            const change = await this.fetchChange(parentSha);
            parentTreeSha = change.rootTreeSha;
        } else {
            const rootTree = {};
            parentTreeSha = await this.saveTree(rootTree);
        }
        const treeEntry: TreeEntry = {
            type: "tree",
            sha: parentTreeSha
        };
        const newTreeEntry = await this.applyChangeToTreeEntry(treeEntry, filePath.split(path.sep), fileContent);
        if (newTreeEntry.sha !== treeEntry.sha) {
            const newChange = {
                timestamp: new Date(),
                rootTreeSha: newTreeEntry.sha,
                parentSha: parentSha
            };
            return await this.saveChange(newChange);
        } else {
            return null;
        }
    }

    public async restoreChange(sha: string): Promise<void> {
        const current = await this.fetchCurrent();
        if (!current) {
            throw new Error(`Change ${sha} not found.`);
        }
        const change = await this.fetchChange(sha);
        const currentTree = await this.fetchTree(current.rootTreeSha);
        const tree = await this.fetchTree(change.rootTreeSha);
        await this.restoreTree(["."], currentTree, tree);
        await fs.writeFile(this.currentRefPath, sha);
    }

    async restoreTree(dirPath: string[], oldTree: Tree | null, newTree: Tree): Promise<void> {
        await mkdirp(path.join(...dirPath));
        for (let entryName in newTree) {
            const entry = newTree[entryName];
            if (entry.type === "blob") {
                await this.restoreBlob(path.join(...dirPath, entryName), entry.sha);
            } else if (entry.type === "tree") {
                const oldEntry = oldTree && oldTree[entryName];
                const oldSubTree = oldEntry && await this.fetchTree(oldEntry.sha);
                const newSubTree = await this.fetchTree(entry.sha);
                await this.restoreTree([...dirPath, entryName], oldSubTree, newSubTree);
            } else {
                throw new Error("Unknown entry type: " + entry["type"]);
            }
        }
        // handle deleting items in old tree that are not in the new tree
        if (oldTree) {
            const entriesToRemove = difference(Object.keys(oldTree), Object.keys(newTree));
            for (let entryName of entriesToRemove) {
                await rmfr(path.join(...[...dirPath, entryName]));
            }
        }
    }

    async restoreBlob(filePath: string, sha: string): Promise<void> {
        const fullFilePath = path.join(this.rootDir, filePath);
        await (fs.copyFile as any)(path.join(this.blobsDir, sha), fullFilePath);
    }

    async saveTree(tree: Tree): Promise<string> {
        const fileContent = JSON.stringify(tree, null, "\t");
        const sha = String(sha1(fileContent));
        const filePath = path.join(this.treesDir, sha);
        await fs.writeFile(filePath, fileContent);
        return sha;
    }

    async saveChange(change: Partial<Change>): Promise<string> {
        const fileContent = JSON.stringify(change, null, "\t");
        const sha = String(sha1(fileContent));
        await fs.writeFile(path.join(this.changesDir, sha), fileContent);
        return sha;
    }

    async fetchChange(sha: string): Promise<Change> {
        const fileContent = (await fs.readFile(path.join(this.changesDir, sha))).toString();
        const change = JSON.parse(fileContent);
        change.sha = sha;
        return change;
    }

    async fetchTree(sha: string): Promise<Tree> {
        const fileContent = (await fs.readFile(path.join(this.treesDir, sha))).toString();
        return JSON.parse(fileContent);
    }

    async fetchBlob(sha: string): Promise<string> {
        return (await fs.readFile(path.join(this.blobsDir, sha))).toString();
    }

    async saveBlob(fileContent: string): Promise<string> {
        const sha = String(sha1(fileContent));
        await fs.writeFile(path.join(this.blobsDir, sha), fileContent);
        return sha;
    }

    async applyChangeToTreeEntry(entry: TreeEntry, filePath: string[], fileContent: string): Promise<TreeEntry> {
        if (filePath.length === 0) {
            const sha = await this.saveBlob(fileContent);
            return {
                type: "blob",
                sha
            };
        } else {
            if (entry.type === "blob") {
                throw new Error("Cannot save a new file within a non-directory.");
            } else if (entry.type === "tree") {
                const [firstPathPart, ...restPathParts] = filePath;
                const subTree = await this.fetchTree(entry.sha);
                let subTreeEntry = subTree[firstPathPart];
                let newSubTreeEntry;
                if (!subTreeEntry) {
                    newSubTreeEntry = await this.generateTreeEntry(restPathParts, fileContent);
                } else {
                    newSubTreeEntry = await this.applyChangeToTreeEntry(subTreeEntry, restPathParts, fileContent);
                }
                const newSubTree = {
                    ...subTree,
                    [firstPathPart]: newSubTreeEntry
                };
                const newSubTreeSha = await this.saveTree(newSubTree);
                return {
                    type: "tree",
                    sha: newSubTreeSha
                };
            } else {
                throw new Error("Unknown tree entry type: " + entry["type"]);
            }
        }
    }

    async generateTreeEntry(filePath: string[], fileContent: string): Promise<TreeEntry> {
        if (filePath.length === 0) {
            const sha = await this.saveBlob(fileContent);
            return {
                type: "blob",
                sha
            };
        } else {
            const [firstPathPart, ...restPathParts] = filePath;
            const subTreeEntry = await this.generateTreeEntry(restPathParts, fileContent);
            const tree = {
                [firstPathPart]: subTreeEntry
            };
            const treeSha = await this.saveTree(tree);
            return {
                type: "tree",
                sha: treeSha
            };
        }
    }

    async fetchCurrentSha(): Promise<string | null> {
        try {
            return (await fs.readFile(this.currentRefPath)).toString();
        } catch (e) {
            return null;
        }
    }

    async fetchCurrent(): Promise<Change | null> {
        const currentSha = await this.fetchCurrentSha();
        return currentSha && this.fetchChange(currentSha) || null;
    }

    get metadataDir(): string {
        return path.join(this.rootDir, ".my-rcs");
    }

    get changesDir(): string {
        return path.join(this.metadataDir, "changes");
    }

    get blobsDir(): string {
        return path.join(this.metadataDir, "blobs");
    }

    get treesDir(): string {
        return path.join(this.metadataDir, "trees");
    }

    get refsDir(): string {
        return path.join(this.metadataDir, "refs");
    }

    get currentRefPath(): string {
        return path.join(this.refsDir, "current");
    }

}