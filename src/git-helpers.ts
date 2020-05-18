import { exec } from "./exec";
import { fs } from "mz";
import * as path from "path";
import { directoryExists } from "./fs-helpers";
import { parsePatch, IUniDiff } from "diff";
import { findIndex, findLastIndex } from "lodash";
import assert = require("assert");

export type FileChangeDetail = {
	fileName: string,
	changeDetail: string
};

export type Commit = {
	sha: string,
	author: string,
	changedFiles: FileChangeDetail[],
	changeSummary: string,
	date: Date,
	message: string
};

export type Tag = {
	tagName: string;
	annotation: string;
	commitSha: string;
}

export type Position = {
	line: number, 
	character: number
};

export type Range = {
	start: Position,
	end: Position
};

export type ChangeRanges = {
	before: Range,
	after: Range
};

export async function getStatus(workingDir: string): Promise<string> {
	const options = {
		cwd: workingDir
	};
	const result = await exec(`git status`, options);
	return result[0].toString();
}

export async function createBranch(workingDir: string, branch: string): Promise<void> {
	const options = {
		cwd: workingDir
	};
	await exec(`git checkout -b ${branch}`, options);
}

export async function checkoutBranch(workingDir: string, branch: string): Promise<void> {
	const options = {
		cwd: workingDir
	};
	await exec(`git checkout ${branch}`, options);
}

export async function restoreToCommitSha(workingDir: string, sha: string): Promise<void> {
	const options = {
		cwd: workingDir
	};
	await exec(`git checkout ${sha} -f`, options);
}

export async function hardReset(workingDir: string, sha: string): Promise<void> {
	const options = {
		cwd: workingDir
	};
	await exec(`git reset --hard ${sha}`, options);
}

export async function restoreToHead(workingDir: string): Promise<void> {
	const options = {
		cwd: workingDir
	};
	await exec("git checkout master -f", options);
}

export async function restoreToBranch(workingDir: string, branch: string): Promise<void> {
	const options = {
		cwd: workingDir
	};
	await exec(`git checkout ${branch} -f`, options);
}

export async function getMasterHead(workingDir: string): Promise<string | null> {
	const options = {
		cwd: workingDir
	};
	try {
		const result = await exec("git rev-parse master", options);
		const output = result[0].toString().trim();
		return output;
	} catch (e) {
		if (e.message.match(/ambiguous argument/)) {
			return null;
		} else {
			throw e;
		}
	}
}

export async function getBranchHead(workingDir: string, branch: string): Promise<string | null> {
	const options = {
		cwd: workingDir
	};
	try {
		const result = await exec(`git rev-parse ${branch}`, options);
		const output = result[0].toString().trim();
		return output;
	} catch (e) {
		if (e.message.match(/ambiguous argument/)) {
			return null;
		} else {
			throw e;
		}
	}
}

export async function getHead(workingDir: string): Promise<string | null> {
	const options = {
		cwd: workingDir
	};
	try {
		const result = await exec("git rev-parse HEAD", options);
		const output = result[0].toString().trim();
		return output;
	} catch (e) {
		if (e.message.match(/ambiguous argument/)) {
			return null;
		} else {
			throw e;
		}
	}
}

export async function getCommit(workingDir: string, sha: string): Promise<Commit> {
	const options = {
		cwd: workingDir,
		maxBuffer: 1000000000000
	};
	const result = await exec(`git show --compact-summary --no-color ${sha}`, options);
	const output = result[0].toString();
	const commits = parseCommitsSummary(output);
	return commits[0];
}

export async function getCommitDiff(workingDir: string, sha: string): Promise<IUniDiff[]> {
	const options = {
		cwd: workingDir,
		maxBuffer: 1000000000000
	};
	const result = await exec(`git show --no-color ${sha}`, options);
	const output = result[0].toString();
	const lines = output.split("\n");
	let state = "waiting";
	let diffLines: string[] = [];
	for (const line of lines) {
		if (state === "collecting") {
			diffLines.push(line);
		} else if (state === "waiting") {
			if (line.match(/^index (.*)$/)) {
				state = "collecting";
			}
		}
	}
	const diff = diffLines.join("\n");
	return parsePatch(diff);
}

export async function getChangeRanges(
	workingDir: string, commitSha: string): Promise<ChangeRanges | undefined> {
	const diff = await getCommitDiff(workingDir, commitSha);
	const hunks = diff[0].hunks;
	const hunk = hunks[hunks.length - 1];
	if (hunk) {
		const lines = hunk.lines
			.filter((line) => line !== "\\ No newline at end of file");
		const newLines = lines
			.filter((line) => line[0] !== "-");
		const oldLines = lines
			.filter((line) => line[0] !== "+");
		const firstNewLineIdx = findIndex(newLines, (line) => line[0] === "+");
		const firstOldLineIdx = findIndex(oldLines, (line) => line[0] === "-");
		
		let before, after;
		if (firstNewLineIdx !== -1) {
			const firstNewLineNo = hunk.newStart + firstNewLineIdx;
			const lastNewLineIdx = findLastIndex(newLines, (line) => line[0] === "+");
			const lastNewLineNo = hunk.newStart + lastNewLineIdx;
			after = {
				start: { line: firstNewLineNo, character: 1 },
				end: { line: lastNewLineNo, character: newLines[lastNewLineIdx].length }
			}
		} else {
			let pos;
			if (firstOldLineIdx === 0) {
				pos = {
					line: 1,
					character: 1
				};
			} else {
				pos = {
					line: hunk.newStart + firstOldLineIdx - 1, 
					character: oldLines[firstOldLineIdx - 1].length
				};
			}
			after = {
				start: pos,
				end: pos
			}
		}

		if (firstOldLineIdx === -1) {
			let pos;
			if (firstNewLineIdx === 0) {
				pos = {
					line: 1, 
					character: 1
				};
			} else {
				pos = {
					line: hunk.oldStart + firstNewLineIdx - 1, 
					character: newLines[firstNewLineIdx - 1].length
				};
			}
			before = {
				start: pos,
				end: pos
			}
		} else {
			const firstOldLineNo = hunk.oldStart + firstOldLineIdx;
			const lastOldLineIdx = findLastIndex(oldLines, (line) => line[0] === "-");
			const lastOldLineNo = hunk.oldStart + lastOldLineIdx;
			before = {
				start: { line: firstOldLineNo, character: 1 },
				end: { line: lastOldLineNo, character: oldLines[lastOldLineIdx].length}
			};
		}

		return { before, after };
	}
	return undefined;
}

export async function getCommitShas(workingDir: string, branch: string): Promise<string[]> {
	const options = {
		cwd: workingDir,
		maxBuffer: 1000000000000
	};
	const result = await exec(`git log --format=format:%H ${branch}`, options);
	const output = result[0].toString();
	return output.split("\n").reverse();
}

export async function getMasterChangeLog(workingDir: string): Promise<Commit[] | null> {
	const options = {
		cwd: workingDir,
		maxBuffer: 1000000000000
	};
	const start = new Date().getTime();
	try {
		const result = await exec("git log --compact-summary --no-color master", options);
		const end = new Date().getTime();
		const elapsedTime = end - start;
		const output = result[0].toString();
		return parseCommitsSummary(output);
	} catch (e) {
		if (e.message.match(/ambiguous argument \'master\'/)) {
			return null;
		} else {
			throw e;
		}
	}
}

export async function getBranchChangeLog(workingDir: string, branch: string): Promise<Commit[] | null> {
	const options = {
		cwd: workingDir,
		maxBuffer: 1000000000000
	};
	const start = new Date().getTime();
	try {
		const result = await exec(`git log --compact-summary --no-color ${branch}`, options);
		const end = new Date().getTime();
		const elapsedTime = end - start;
		const output = result[0].toString();
		return parseCommitsSummary(output);
	} catch (e) {
		if (e.message.match(/ambiguous argument/)) {
			return null;
		} else {
			throw e;
		}
	}
}

export function parseCommitsSummary(output: string): Commit[] {
	let state: "begin" | "author" | "date" | "message-begin" | "message-middle" | "fileset" | "end" = "begin";
	const commits: Commit[] = [];
	let commit: Partial<Commit> = {
		message: "",
		changedFiles: []
	};
	const lines = output.split("\n");
	for (let line of lines) {
		if (state === "begin") {
			const m = assertExists(line.match(/^commit ([a-z0-9]+)$/));
			commit.sha = m[1];
			state = "author";
		} else if (state === "author") {
			const m0 = line.match(/^Merge: .*$/);
			if (m0) {
				continue;
			}
			const m = assertExists(line.match(/^Author: (.*)$/));
			commit.author = m[1];
			state = "date";
		} else if (state === "date") {
			const m = assertExists(line.match(/^Date: (.*)$/));
			commit.date = new Date(m[1]);
			state = "message-begin";
		} else if (state === "message-begin") {
			state = "message-middle";
			continue;
		} else if (state === "message-middle") {
			if (line === "") {
				state = "fileset";
			} else {
				commit.message += line.trim() + "\n";
			}
		} else if (state === "fileset") {
			const m = line.match((/^ (.+)\|(.+)$/));
			if (m) {
				let fileName = m[1].trim();
				let m2;
				if (m2 = fileName.match(/^(.*) \(new\)$/)) {
					fileName = m2[1];
				}
				assertExists(commit.changedFiles).push({
					fileName,
					changeDetail: m[2].trim()
				});
			} else {
				const m2 = line.match(/^commit ([a-z0-9]+)$/);
				if (m2) {
					acceptCommit();
					commit.sha = m2[1];
					state = "author";
				} else {
					commit.changeSummary = line.trim();
					state = "end";
				}
			}
		} else if (state === "end") {
			if (line !== "") {
				throw new Error("Empty line expected after change summary but got: " + line);
			}
			acceptCommit();
			state = "begin";
		}
	}
	if (commit.sha) {
		acceptCommit();
	}
	commits.reverse();
	return commits;

	function acceptCommit() {
		commits.push(commit as Commit);
		commit = {
			message: "",
			changedFiles: []
		};
	}
}

export async function save(workingDir: string): Promise<boolean> {
	const options = {
		cwd: workingDir,
		maxBuffer: 1000000000000
	};
	await exec("git add .", options);
	try {
		await exec("git commit -m 'Update by Drive By.'", options);
		return true;
	} catch (e) {
		if (e.message.match(/no changes added to commit/)) {
			return false;
		} else if (e.message.match(/nothing to commit/)) {
			return false;
		} else {
			throw e;
		}
	}
}

export async function ensureGitInitialized(workingDir: string) {
    try {
        const stat = await fs.stat(path.join(workingDir, ".git"));
    } catch (e) {
        await exec("git init", {
			cwd: workingDir
		});
    }
}

export async function initializeGitRepo(workingDir: string): Promise<void> {
	await exec("git init", {
		cwd: workingDir
	});
}

export async function isGitInitialized(workingDir: string) {
	return directoryExists(path.join(workingDir, ".git"));
}

export async function getTop5ChangedFiles(workingDir: string, sha: string): Promise<string[]> {
	const options = {
		cwd: workingDir
	};
	const result = await exec(`git show ${sha} --pretty=format: --name-only | head -5`, options);
	const output = result[0].toString();
	return output.split("\n").filter((line) => !!line);
}

export async function getBranches(workingDir: string): Promise<string[]> {
	const options = {
		cwd: workingDir
	};
	const result = await exec(`git branch`, options);
	const output = result[0].toString();
	return output.split("\n").filter(line => !!line).map((line) => line.substring(2));
}

export async function getTags(workingDir: string): Promise<string[]> {
	const options = {
		cwd: workingDir
	};
	const result = await exec(`git tag -l`, options);
	const output = result[0].toString();
	return output.split("\n").filter(line => !!line);
}

export async function createTag(workingDir: string, tagName: string, commitSha: string, annotation: string): Promise<void> {
	const options = {
		cwd: workingDir
	};
	await exec(`git tag -a -m "${annotation}" ${tagName} ${commitSha}`, options);
}

export async function getTag(workingDir: string, tagName: string): Promise<Tag | null> {
	const options = {
		cwd: workingDir
	};
	try {
		const result = await exec(`git tag -v ${tagName}`, options);
	} catch (e) {
		const lines = e.message.split("\n");
		let annotationLines: string[] = [];
		let state: string = "open";
		const tag = { tagName } as Tag;
		for (let line of lines) {
			let m;
			if (state === "beginAnnotation") {
				if (line === "") {
					state = "collectAnnotation";
				} else {
					break;
				}
			} else if (state === "collectAnnotation") {
				if (line === "") {
					break;
				} else {
					annotationLines.push(line);
				}
			} else if (state === "open") {
				if (m = line.match(/^object (.+)$/)) {
					tag.commitSha = m[1];
				} else if (m = line.match(/^tagger (.+)$/)) {
					state = "beginAnnotation";
				}
			}
		}
		const annotation = annotationLines.join("\n");
		tag.annotation = annotation;
		return tag;
	}
	return null;
}

function assertExists<T>(value: T | null | undefined, message: string = "Could not find thing"): T {
	if (value === null || value === undefined) {
		throw new Error(message);
	} else {
		return value;
	}
}