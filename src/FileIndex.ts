import { ApiError, ErrorCode } from './ApiError.js';
import type { Cred } from './cred.js';
import { basename, dirname, join } from './emulation/path.js';
import { NoSyncFile, type FileFlag } from './file.js';
import { FileSystem, Sync, Async, Readonly } from './filesystem.js';
import { FileType, Stats } from './stats.js';

/**
 * @internal
 */
export type ListingTree = { [key: string]: ListingTree | null };

/**
 * @internal
 */
export interface ListingQueueNode<T> {
	pwd: string;
	tree: ListingTree;
	parent: IndexDirInode<T>;
}

/**
 * A simple class for storing a filesystem index. Assumes that all paths passed
 * to it are *absolute* paths.
 *
 * Can be used as a partial or a full index, although care must be taken if used
 * for the former purpose, especially when directories are concerned.
 *
 * @internal
 */
export class FileIndex<T> {
	/**
	 * Static method for constructing indices from a JSON listing.
	 * @param listing Directory listing generated by tools
	 * @return A new FileIndex object.
	 */
	public static FromListing<T>(listing: ListingTree): FileIndex<T> {
		const index = new FileIndex<T>();
		// Add a root DirNode.
		const rootInode = new IndexDirInode<T>();
		index._index.set('/', rootInode);
		const queue: ListingQueueNode<T | Stats>[] = [{ pwd: '', tree: listing, parent: rootInode }];
		while (queue.length > 0) {
			let inode: IndexFileInode<Stats> | IndexDirInode<T>;
			const { tree, pwd, parent } = queue.pop()!;
			for (const node in tree) {
				if (!Object.hasOwn(tree, node)) {
					continue;
				}
				const children = tree[node];

				if (children) {
					const path = pwd + '/' + node;
					inode = new IndexDirInode<T>();
					index._index.set(path, inode);
					queue.push({ pwd: path, tree: children, parent: inode });
				} else {
					// This inode doesn't have correct size information, noted with -1.
					inode = new IndexFileInode<Stats>(new Stats(FileType.FILE, -1, 0o555));
				}
				if (!parent) {
					continue;
				}
				parent._listing.set(node, inode);
			}
		}
		return index;
	}

	// Maps directory paths to directory inodes, which contain files.
	protected _index: Map<string, IndexDirInode<T>> = new Map();

	/**
	 * Constructs a new FileIndex.
	 */
	constructor() {
		// _index is a single-level key,value store that maps *directory* paths to
		// DirInodes. File information is only contained in DirInodes themselves.
		// Create the root directory.
		this.add('/', new IndexDirInode());
	}

	public files(): IndexFileInode<T>[] {
		const files: IndexFileInode<T>[] = [];

		for (const dir of this._index.values()) {
			for (const file of dir.listing) {
				const item = dir.get(file);
				if (!item?.isFile()) {
					continue;
				}

				files.push(item);
			}
		}
		return files;
	}

	/**
	 * Adds the given absolute path to the index if it is not already in the index.
	 * Creates any needed parent directories.
	 * @param path The path to add to the index.
	 * @param inode The inode for the
	 *   path to add.
	 * @return 'True' if it was added or already exists, 'false' if there
	 *   was an issue adding it (e.g. item in path is a file, item exists but is
	 *   different).
	 * @todo If adding fails and implicitly creates directories, we do not clean up
	 *   the new empty directories.
	 */
	public add(path: string, inode: IndexInode<T>): boolean {
		if (!inode) {
			throw new Error('Inode must be specified');
		}
		if (!path.startsWith('/')) {
			throw new Error('Path must be absolute, got: ' + path);
		}

		// Check if it already exists.
		if (this._index.has(path)) {
			return this._index.get(path) === inode;
		}

		const dirpath = dirname(path);

		// Try to add to its parent directory first.
		let parent = this._index.get(dirpath);
		if (!parent && path != '/') {
			// Create parent.
			parent = new IndexDirInode<T>();
			if (!this.add(dirpath, parent)) {
				return false;
			}
		}

		// Add to parent.
		if (path != '/' && !parent.add(basename(path), inode)) {
			return false;
		}

		// If a directory, add to the index.
		if (inode.isDirectory()) {
			this._index.set(path, inode);
		}
		return true;
	}

	/**
	 * Adds the given absolute path to the index if it is not already in the index.
	 * The path is added without special treatment (no joining of adjacent separators, etc).
	 * Creates any needed parent directories.
	 * @param path The path to add to the index.
	 * @param inode The inode for the path to add.
	 * @return 'True' if it was added or already exists, 'false' if there
	 *   was an issue adding it (e.g. item in path is a file, item exists but is
	 *   different).
	 * @todo If adding fails and implicitly creates directories, we do not clean up the new empty directories.
	 */
	public addFast(path: string, inode: IndexInode<T>): boolean {
		const parentPath = dirname(path);
		const itemName = basename(path);

		// Try to add to its parent directory first.
		let parent = this._index.get(parentPath);
		if (!parent) {
			// Create parent.
			parent = new IndexDirInode<T>();
			this.addFast(parentPath, parent);
		}

		if (!parent.add(itemName, inode)) {
			return false;
		}

		// If adding a directory, add to the index as well.
		if (inode.isDirectory()) {
			this._index.set(path, <IndexDirInode<T>>inode);
		}
		return true;
	}

	/**
	 * Removes the given path. Can be a file or a directory.
	 * @return The removed item,
	 *   or null if it did not exist.
	 */
	public remove(path: string): IndexInode<T> | null {
		const dirpath = dirname(path);

		// Try to remove it from its parent directory first.
		const parent = this._index.get(dirpath);
		if (!parent) {
			return;
		}
		// Remove from parent.
		const inode = parent.remove(basename(path));
		if (!inode) {
			return;
		}

		if (!inode.isDirectory()) {
			return inode;
		}
		// If a directory, remove from the index, and remove children.
		const children = inode.listing;
		for (const child of children) {
			this.remove(join(path, child));
		}

		// Remove the directory from the index, unless it's the root.
		if (path != '/') {
			this._index.delete(path);
		}
	}

	/**
	 * Retrieves the directory listing of the given path.
	 * @return An array of files in the given path, or 'null' if it does not exist.
	 */
	public ls(path: string): string[] | null {
		return this._index.get(path)?.listing;
	}

	/**
	 * Returns the inode of the given item.
	 * @return Returns null if the item does not exist.
	 */
	public get(path: string): IndexInode<T> | null {
		const dirpath = dirname(path);

		// Retrieve from its parent directory.
		const parent = this._index.get(dirpath);
		// Root case
		if (dirpath == path) {
			return parent;
		}
		return parent?.get(basename(path));
	}
}

/**
 * Generic interface for file/directory inodes.
 * Note that Stats objects are what we use for file inodes.
 */
export abstract class IndexInode<T> {
	constructor(public data?: T) {}
	/**
	 * Whether this inode is for a file
	 */
	abstract isFile(): this is IndexFileInode<T>;
	/**
	 * Whether this inode is for a directory
	 */
	abstract isDirectory(): this is IndexDirInode<T>;

	abstract toStats(): Stats;
}

/**
 * Inode for a file. Stores an arbitrary (filesystem-specific) data payload.
 */
export class IndexFileInode<T> extends IndexInode<T> {
	public isFile() {
		return true;
	}
	public isDirectory() {
		return false;
	}

	public toStats(): Stats {
		return new Stats(FileType.FILE, 4096, 0o666);
	}
}

/**
 * Inode for a directory. Currently only contains the directory listing.
 */
export class IndexDirInode<T> extends IndexInode<T> {
	/**
	 * @internal
	 */
	_listing: Map<string, IndexInode<T>> = new Map();

	public isFile(): boolean {
		return false;
	}

	public isDirectory(): boolean {
		return true;
	}

	/**
	 * Return a Stats object for this inode.
	 * @todo Should probably remove this at some point. This isn't the responsibility of the FileIndex.
	 */
	public get stats(): Stats {
		return new Stats(FileType.DIRECTORY, 4096, 0o555);
	}
	/**
	 * Alias of getStats()
	 * @todo Remove this at some point. This isn't the responsibility of the FileIndex.
	 */
	public toStats(): Stats {
		return this.stats;
	}
	/**
	 * Returns the directory listing for this directory. Paths in the directory are
	 * relative to the directory's path.
	 * @return The directory listing for this directory.
	 */
	public get listing(): string[] {
		return [...this._listing.keys()];
	}

	/**
	 * Returns the inode for the indicated item, or null if it does not exist.
	 * @param path Name of item in this directory.
	 */
	public get(path: string): IndexInode<T> | null {
		return this._listing.get(path);
	}
	/**
	 * Add the given item to the directory listing. Note that the given inode is
	 * not copied, and will be mutated by the DirInode if it is a DirInode.
	 * @param path Item name to add to the directory listing.
	 * @param inode The inode for the
	 *   item to add to the directory inode.
	 * @return True if it was added, false if it already existed.
	 */
	public add(path: string, inode: IndexInode<T>): boolean {
		if (this._listing.has(path)) {
			return false;
		}
		this._listing.set(path, inode);
		return true;
	}
	/**
	 * Removes the given item from the directory listing.
	 * @param p Name of item to remove from the directory listing.
	 * @return Returns the item
	 *   removed, or null if the item did not exist.
	 */
	public remove(p: string): IndexInode<T> | null {
		const item = this._listing.get(p);
		if (!item) {
			return;
		}
		this._listing.delete(p);
		return item;
	}
}

export abstract class FileIndexFS<TIndex> extends Readonly(FileSystem) {
	protected _index: FileIndex<TIndex>;

	constructor(index: ListingTree) {
		super();
		this._index = FileIndex.FromListing<TIndex>(index);
	}

	public async stat(path: string): Promise<Stats> {
		const inode = this._index.get(path);
		if (!inode) {
			throw ApiError.ENOENT(path);
		}

		if (inode.isDirectory()) {
			return inode.stats;
		}

		if (inode.isFile()) {
			return this.statFileInode(inode);
		}

		throw new ApiError(ErrorCode.EINVAL, 'Invalid inode.');
	}

	public statSync(path: string): Stats {
		const inode = this._index.get(path);
		if (!inode) {
			throw ApiError.ENOENT(path);
		}

		if (inode.isDirectory()) {
			return inode.stats;
		}

		if (inode.isFile()) {
			return this.statFileInodeSync(inode);
		}

		throw new ApiError(ErrorCode.EINVAL, 'Invalid inode.');
	}

	public async openFile(path: string, flag: FileFlag, cred: Cred): Promise<NoSyncFile<this>> {
		if (flag.isWriteable()) {
			// You can't write to files on this file system.
			throw new ApiError(ErrorCode.EPERM, path);
		}

		// Check if the path exists, and is a file.
		const inode = this._index.get(path);

		if (!inode) {
			throw ApiError.ENOENT(path);
		}

		if (!inode.toStats().hasAccess(flag.mode, cred)) {
			throw ApiError.EACCES(path);
		}

		if (inode.isDirectory()) {
			const stats = inode.stats;
			return new NoSyncFile(this, path, flag, stats, stats.fileData);
		}

		return this.fileForFileInode(inode, path, flag);
	}

	public openFileSync(path: string, flag: FileFlag, cred: Cred): NoSyncFile<this> {
		if (flag.isWriteable()) {
			// You can't write to files on this file system.
			throw new ApiError(ErrorCode.EPERM, path);
		}

		// Check if the path exists, and is a file.
		const inode = this._index.get(path);

		if (!inode) {
			throw ApiError.ENOENT(path);
		}

		if (!inode.toStats().hasAccess(flag.mode, cred)) {
			throw ApiError.EACCES(path);
		}

		if (inode.isDirectory()) {
			const stats = inode.stats;
			return new NoSyncFile(this, path, flag, stats, stats.fileData);
		}

		return this.fileForFileInodeSync(inode, path, flag);
	}

	public async readdir(path: string): Promise<string[]> {
		// Check if it exists.
		const inode = this._index.get(path);
		if (!inode) {
			throw ApiError.ENOENT(path);
		}

		if (inode.isDirectory()) {
			return inode.listing;
		}

		throw ApiError.ENOTDIR(path);
	}

	public readdirSync(path: string): string[] {
		// Check if it exists.
		const inode = this._index.get(path);
		if (!inode) {
			throw ApiError.ENOENT(path);
		}

		if (inode.isDirectory()) {
			return inode.listing;
		}

		throw ApiError.ENOTDIR(path);
	}

	protected abstract statFileInode(inode: IndexFileInode<TIndex>): Promise<Stats>;

	protected abstract statFileInodeSync(inode: IndexFileInode<TIndex>): Stats;

	protected abstract fileForFileInode(inode: IndexFileInode<TIndex>, path: string, flag: FileFlag): Promise<NoSyncFile<this>>;

	protected abstract fileForFileInodeSync(inode: IndexFileInode<TIndex>, path: string, flag: FileFlag): NoSyncFile<this>;
}

export abstract class SyncFileIndexFS<TIndex> extends Sync(FileIndexFS<unknown>) {
	protected async statFileInode(inode: IndexFileInode<TIndex>): Promise<Stats> {
		return this.statFileInodeSync(inode);
	}

	protected async fileForFileInode(inode: IndexFileInode<TIndex>, path: string, flag: FileFlag): Promise<NoSyncFile<this>> {
		return this.fileForFileInodeSync(inode, path, flag);
	}
}

export abstract class AsyncFileIndexFS<TIndex> extends Async(FileIndexFS<unknown>) {
	protected statFileInodeSync(): Stats {
		throw new ApiError(ErrorCode.ENOTSUP);
	}

	protected fileForFileInodeSync(): NoSyncFile<this> {
		throw new ApiError(ErrorCode.ENOTSUP);
	}
}
