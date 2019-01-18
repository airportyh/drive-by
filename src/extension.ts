// TODO: https://stackoverflow.com/questions/1386291/git-git-dir-not-working-as-expected

import { workspace, ExtensionContext, TextDocumentChangeEvent, window } from 'vscode';
import { debounce } from "lodash";
import { child_process, fs } from "mz";
import * as path from "path";

function getWorkspaceFolder(filePath: string): string | null {
	const folders = workspace.workspaceFolders;
	if (!folders) {
		return null;
	}
	for (let folder of folders) {
		if (filePath.indexOf(folder.uri.fsPath) === 0) {
			return folder.uri.fsPath;
		}
	}
	return null;
}



export function activate(context: ExtensionContext) {

	workspace.onDidChangeWorkspaceFolders(() => {
		
	});

	const onChange = debounce(async (changeEvent: TextDocumentChangeEvent) => {
		if (changeEvent) {
			const document = changeEvent.document;
			const filePath = document.uri.fsPath;
			const folder = getWorkspaceFolder(filePath);
			if (folder) {
				await document.save();
				await save(folder);
			} else {
				window.showInformationMessage("No workspace found.");
			}
		} else {
			throw new Error("BLARGH");
		}
	}, 500);

	workspace.onDidChangeTextDocument(onChange);
}

async function save(workingDir: string): Promise<void> {
	const options = {
		cwd: workingDir
	};
	await ensureGitInitialized(workingDir);
	await child_process.exec("git add .", options);
	await child_process.exec("git commit -m 'Update by Drive By.'", options);
}

async function ensureGitInitialized(workingDir: string) {
    try {
        const stat = await fs.stat(path.join(workingDir, ".git"));
    } catch (e) {
        await child_process.exec("git init", {
			cwd: workingDir
		});
    }
}

export function deactivate() {}
