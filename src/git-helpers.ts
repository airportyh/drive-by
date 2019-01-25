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

export async function restoreCommit(workingDir: string, sha: string): Promise<void> {
	const options = {
		cwd: workingDir
	};
	const head = await getMasterHead(workingDir);
	if (head === sha) {
		await restoreToHead(workingDir);
	} else {
		await exec(`git checkout ${sha}`, options);
	}
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
	await exec("git checkout master", options);
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

export async function getMasterChangeLog(workingDir: string): Promise<Commit[]> {
	const options = {
		cwd: workingDir
	};
	const result = await exec("git log --compact-summary --no-color master", options);
	const output = result[0].toString();
	return parseCommitsSummary(output);
}

function parseCommitsSummary(output: string): Commit[] {
	let state: "begin" | "author" | "date" | "message-begin" | "message-middle" | "fileset" | "end" = "begin";
	const commits: Commit[] = [];
	let commit: Partial<Commit> = {
		message: "",
		changedFiles: []
	};
	const lines = output.split("\n");
	for (let line of lines) {
		console.log("state:", state, "line:", line);
		if (state === "begin") {
			const m = assertExists(line.match(/^commit ([a-z0-9]+)$/));
			commit.sha = m[1];
			state = "author";
		} else if (state === "author") {
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
				commit.changeSummary = line.trim();
				state = "end";
			}
		} else if (state === "end") {
			if (line !== "") {
				throw new Error("Empty line expected after change summary");
			}
			if (commit.sha && commit.author && commit.changedFiles && commit.changeSummary && commit.date && commit.message) {
				commits.push(commit as Commit);
				commit = {
					message: "",
					changedFiles: []
				};
			} else {
				throw new Error("Incomplete information gathered for commit");
			}
			
			state = "begin";
		}
	}
	commits.reverse();
	return commits;
}

export async function save(workingDir: string): Promise<void> {
	const options = {
		cwd: workingDir
	};
	await exec("git add .", options);
	try {
		await exec("git commit -m 'Update by Drive By.'", options);
	} catch (e) {
		if (e.message.match(/nothing to commit/)) {
			return;
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

export async function status(workingDir: string) {
	const options = {
		cwd: workingDir
	};
	const result = await exec("git status", options);
	console.log(result[0].toString());
}

export async function isGitInitialized(workingDir: string) {
	return directoryExists(path.join(workingDir, ".git"));
}

export async function getChangedFiles(workingDir: string, sha: string): Promise<string[]> {
	const options = {
		cwd: workingDir
	};
	const result = await exec(`git show ${sha} --pretty=format: --name-only`, options);
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