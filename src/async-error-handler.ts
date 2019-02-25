import { window } from "vscode";

export function asyncErrorHandler(fn: (...args) => Promise<any>): () => Promise<any> {
	return async (...args) => {
		try {
			await fn(...args);
		} catch (e) {
			console.log(e.stack);
			window.showInformationMessage(e.stack);
		}
	};
}