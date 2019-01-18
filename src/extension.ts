// TODO: https://stackoverflow.com/questions/1386291/git-git-dir-not-working-as-expected

import { workspace, ExtensionContext, TextDocumentChangeEvent, window, commands, TreeDataProvider } from 'vscode';
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


class ChangeLogTreeProvider implements TreeDataProvider<TreeNode> {

	private changeEmitter: EventEmitter<TreeNode | undefined> = new EventEmitter<TreeNode | undefined>();
	readonly onDidChangeTreeData: Event<TreeNode | undefined | null> = this.changeEmitter.event;
	
	constructor(private rcsProvider: RCSProvider) {}

	refresh(): void {
		this.changeEmitter.fire();
	}

	getTreeItem(node: TreeNode): TreeItem {
		if (node.type === "change") {
			const label = moment(node.change.timestamp).calendar() + 
			" - " + node.change.sha.substring(0, 6) + "...";
			const item = new TreeItem(label,
				TreeItemCollapsibleState.None);
			if (node.isLatest) {
				item.iconPath = Uri.file(path.join(__filename, "..", "..", "media", "latest.svg"));
			}
			if (node.isCurrent) {
				item.iconPath = Uri.file(path.join(__filename, "..", "..", "media", "current.svg"));
			}
			return item;
		} else if (node.type === "folder") {
			return new TreeItem(node.folder.name, TreeItemCollapsibleState.Expanded);
		} else {
			throw new Error("Unknown node type: " + node["type"]);
		}
	}

	async getChildren(node?: TreeNode): Promise<TreeNode[]> {
		if (!node) {
			const folders = workspace.workspaceFolders;
			if (!folders) {
				return [];
			}
			return folders.map((folder) => {
				return { type: "folder", folder } as TreeNode;
			});
		} else if (node.type === "folder") {
			const rcs = await this.rcsProvider.getRCS(folderPath(node));
			const changeLog = await rcs.getChangeLog();
			const latest = await rcs.getLatestSha();
			const current = await rcs.getCurrentSha();
			return changeLog.map((change) => {
				return <ChangeTreeNode>{
					type: "change",
					isCurrent: change.sha === current,
					isLatest: change.sha === latest,
					change: change,
					folder: node
				};
			});
		} else if (node.type === "change") {
			return [];
		} else {
			return [];
		}
	}
}

export function activate(context: ExtensionContext) {
	const treeProvider = new ChangeLogTreeProvider();
	window.registerTreeDataProvider("change-log", treeProvider);
	commands.registerCommand("driveBy.refresh", () => {
		treeProvider.refresh();
	});

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
