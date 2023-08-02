import * as BrowserFS from '../../../src/core/browserfs';

describe('Indexed File Systems', () => {
	test('Root Directory Exists', async () => {
		await BrowserFS.Backend.InMemory.CreateAsync({});
		const fs = BrowserFS.BFSRequire('fs');
		expect(() => fs.statSync('/')).not.toThrow();
	});
});
