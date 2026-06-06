import { createExpressApp } from '../../../scripts/vite-plugin-sqlite-api';
import express from 'express';

export function setupTestHarness(): express.Express {
	// Any setup for in-memory DB is handled by vitest environment or db.ts reading process.env.VITEST
	return createExpressApp();
}
