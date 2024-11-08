import type { Backend, BackendConfiguration, FilesystemOf, SharedConfig } from './backends/backend.js';
import { checkOptions, isBackend, isBackendConfig } from './backends/backend.js';
import { credentials } from './credentials.js';
import { DeviceFS } from './devices.js';
import * as cache from './emulation/cache.js';
import { config } from './emulation/config.js';
import * as fs from './emulation/index.js';
import type { AbsolutePath } from './emulation/path.js';
import { type MountObject } from './emulation/shared.js';
import { Errno, ErrnoError } from './error.js';
import { FileSystem } from './filesystem.js';

/**
 * Configuration for a specific mount point
 */
export type MountConfiguration<T extends Backend> = FilesystemOf<T> | BackendConfiguration<T> | T;

function isMountConfig<T extends Backend>(arg: unknown): arg is MountConfiguration<T> {
	return isBackendConfig(arg) || isBackend(arg) || arg instanceof FileSystem;
}

/**
 * Retrieve a file system with `configuration`.
 * @see MountConfiguration
 */
export async function resolveMountConfig<T extends Backend>(configuration: MountConfiguration<T>, _depth = 0): Promise<FilesystemOf<T>> {
	if (typeof configuration !== 'object' || configuration == null) {
		throw new ErrnoError(Errno.EINVAL, 'Invalid options on mount configuration');
	}

	if (!isMountConfig(configuration)) {
		throw new ErrnoError(Errno.EINVAL, 'Invalid mount configuration');
	}

	if (configuration instanceof FileSystem) {
		await configuration.ready();
		return configuration;
	}

	if (isBackend(configuration)) {
		configuration = { backend: configuration } as BackendConfiguration<T>;
	}

	for (const [key, value] of Object.entries(configuration)) {
		if (key == 'backend') {
			continue;
		}

		if (!isMountConfig(value)) {
			continue;
		}

		if (_depth > 10) {
			throw new ErrnoError(Errno.EINVAL, 'Invalid configuration, too deep and possibly infinite');
		}

		(configuration as Record<string, FileSystem>)[key] = await resolveMountConfig(value, ++_depth);
	}

	const { backend } = configuration;

	if (!(await backend.isAvailable())) {
		throw new ErrnoError(Errno.EPERM, 'Backend not available: ' + backend.name);
	}
	await checkOptions(backend, configuration);
	const mount = (await backend.create(configuration)) as FilesystemOf<T>;
	mount._disableSync = configuration.disableAsyncCache || false;
	await mount.ready();
	return mount;
}

export interface ConfigMounts {
	[K: AbsolutePath]: Backend;
}

/**
 * Configuration
 */
export interface Configuration<T extends ConfigMounts> extends SharedConfig {
	/**
	 * An object mapping mount points to mount configuration
	 */
	mounts: { [K in keyof T & AbsolutePath]: MountConfiguration<T[K]> };

	/**
	 * The uid to use
	 * @default 0
	 */
	uid: number;

	/**
	 * The gid to use
	 * @default 0
	 */
	gid: number;

	/**
	 * Whether to automatically add normal Linux devices
	 * @experimental
	 * @default false
	 */
	addDevices: boolean;

	/**
	 * If true, enables caching stats for certain operations.
	 * This should reduce the number of stat calls performed.
	 * @experimental
	 * @default false
	 */
	cacheStats: boolean;

	/**
	 * If true, disables *all* permissions checking.
	 *
	 * This can increase performance.
	 * @experimental
	 * @default false
	 */
	disableAccessChecks: boolean;

	/**
	 * If true, disables `read` and `readSync` from updating the atime.
	 *
	 * This can increase performance.
	 * @experimental
	 * @default false
	 */
	disableUpdateOnRead: boolean;

	/**
	 * If true, files will only sync to the file system when closed.
	 *
	 * This can increase performance.
	 * @experimental
	 * @overrides `disableUpdateOnRead`
	 * @default false
	 */
	onlySyncOnClose: boolean;
}

/**
 * Configures ZenFS with single mount point /
 */
export async function configureSingle<T extends Backend>(configuration: MountConfiguration<T>): Promise<void> {
	if (!isBackendConfig(configuration)) {
		throw new TypeError('Invalid single mount point configuration');
	}

	const resolved = await resolveMountConfig(configuration);
	fs.umount('/');
	fs.mount('/', resolved);
}

/**
 * Configures ZenFS with `configuration`
 * @see Configuration
 */
export async function configure<T extends ConfigMounts>(configuration: Partial<Configuration<T>>): Promise<void> {
	const uid = 'uid' in configuration ? configuration.uid || 0 : 0;
	const gid = 'gid' in configuration ? configuration.gid || 0 : 0;

	Object.assign(credentials, { uid, gid, suid: uid, sgid: gid, euid: uid, egid: gid });

	cache.setEnabled(configuration.cacheStats ?? false);
	config.checkAccess = !configuration.disableAccessChecks;
	config.updateOnRead = !configuration.disableUpdateOnRead;
	config.syncImmediately = !configuration.onlySyncOnClose;

	if (configuration.addDevices) {
		const devfs = new DeviceFS();
		devfs.addDefaults();
		await devfs.ready();
		fs.mount('/dev', devfs);
	}

	if (!configuration.mounts) {
		return;
	}

	for (const [point, mountConfig] of Object.entries(configuration.mounts)) {
		if (!point.startsWith('/')) {
			throw new ErrnoError(Errno.EINVAL, 'Mount points must have absolute paths');
		}

		if (isBackendConfig(mountConfig)) {
			mountConfig.disableAsyncCache ??= configuration.disableAsyncCache || false;
		}

		configuration.mounts[point as keyof T & `/${string}`] = await resolveMountConfig(mountConfig);
	}

	fs.mountObject(configuration.mounts as MountObject);
}
