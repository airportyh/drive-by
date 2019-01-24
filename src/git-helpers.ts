import { exec } from "./exec";
import { fs } from "mz";
import * as path from "path";
import { directoryExists } from "./fs-helpers";

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

export async function getMasterChangeLog(workingDir: string): Promise<string[]> {
	const options = {
		cwd: workingDir
	};
	const result = await exec("git log --summary master", options);
	const output = result[0].toString();
	const lines = output.split("\n");
	const commits: string[] = [];
	for (let line of lines) {
		if (line.substring(0, 7) === "commit ") {
			const commit = line.substring(7);
			commits.push(commit);
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