import { TreeDataProvider, TreeItem } from "vscode";

export class CantUseTreeProvider implements TreeDataProvider<TreeItem> {
	getTreeItem(element: any): TreeItem {
		return element;
	}

	getChildren(element?: TreeItem): TreeItem[] {
		if (!element) {
			const notice = new TreeItem("Cannot start Drive By :(");
			notice.tooltip = "You can only use Drive By when there is exactly one workspace folder.";
			return [notice];
		} else {
			return [];
		}
	}
}

export class MenuTreeProvider implements TreeDataProvider<TreeItem>{
	getTreeItem(element: any): TreeItem {
		return element;
	}

	getChildren(element?: TreeItem): TreeItem[] {
		if (!element) {
			const activate = new TreeItem("Start session...");
			activate.command = {
				title: "Start",
				command: "driveBy.start"
			};
			return [activate];
		} else {
			return [];
		}
	}

}