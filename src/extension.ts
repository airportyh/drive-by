import { ExtensionContext } from 'vscode';
import { DriveBy } from './drive-by';

let driveBy: DriveBy | null = null;

export function activate(context: ExtensionContext) {
	driveBy = new DriveBy(context);
	driveBy.initialize();
}

export function deactivate() {
	if (driveBy) {
		driveBy.cleanUp();
		driveBy = null;
	}
}




