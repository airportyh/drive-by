import { fs } from "mz";

export async function directoryExists(path: string): Promise<boolean> {
    try {
        const stat = await fs.lstat(path);
        return stat.isDirectory();
    } catch (e) {
        return false;
    }
}