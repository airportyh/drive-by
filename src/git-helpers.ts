import { exec } from "./exec";
import { fs } from "mz";
import * as path from "path";
import { directoryExists } from "./fs-helpers";

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

export async function getStatus(workingDir: string): Promise<string> {
	const options = {
		cwd: workingDir
	};
	const result = await exec(`git status`, options);
	return result[0];
}

export async function restoreToCommitSha(workingDir: string, sha: string): Promise<void> {
	const options = {
		cwd: workingDir
	};
	await exec(`git checkout ${sha} -f`, options);
}

export async function reset(workingDir: string): Promise<void> {
	const options = {
		cwd: workingDir
	};
	await exec(`git reset --hard HEAD`, options);
}

export async function restoreToHead(workingDir: string): Promise<void> {
	const options = {
		cwd: workingDir
	};
	await exec("git checkout master -f", options);
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
		if (e.message.match(/ambiguous argument \'master\'/)) {
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
		if (e.message.match(/ambiguous argument \'HEAD\'/)) {
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

export async function getCommitShas(workingDir: string): Promise<string[]> {
	const options = {
		cwd: workingDir,
		maxBuffer: 1000000000000
	};
	const result = await exec(`git log --format=format:%H master`, options);
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
				assertExists(commit.changedFiles).push({
					fileName: m[1].trim(),
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
		cwd: workingDir
	};
	await exec("git add .", options);
	try {
		await exec("git commit -m 'Update by Drive By.'", options);
		return true;
	} catch (e) {
		if (e.message.match(/nothing to commit/)) {
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

function assertExists<T>(value: T | null | undefined, message: string = "Could not find thing"): T {
	if (value === null || value === undefined) {
		throw new Error(message);
	} else {
		return value;
	}
}