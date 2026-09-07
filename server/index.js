#!/usr/bin/env node
// Load environment variables before other imports execute
import './load-env.js';
import { randomUUID } from 'node:crypto';
import fs, { promises as fsPromises } from 'fs';
import path from 'path';
import os from 'os';

import express from 'express';
import mime from 'mime-types';
import Database from 'better-sqlite3';

import { AppError, WORKSPACES_ROOT, getOpenCodeDatabasePath, validateWorkspacePath } from '@/shared/utils.js';
import {
    openProjectFileForWrite,
    resolveProjectEntryForMutation,
    resolveProjectFileForRead,
    resolveProjectFileForWrite
} from '@/shared/project-file-containment.js';
import { closeSessionsWatcher, configureSessionWorktrees, initializeSessionsWatcher } from '@/modules/providers/index.js';

import { getConnectableHost } from '../shared/networkHosts.js';

import { GjcJobProjectionService } from './modules/websocket/services/gjc-job-projection.service.js';
import { drainWebSocketClients } from './modules/websocket/services/websocket-drain.service.js';
import { createGjcTerminalNotificationAdapter } from './modules/notifications/services/gjc-terminal-notification-adapter.service.js';
import { findAppRoot, getModuleDir } from './utils/runtime-paths.js';
import {
    abortGjcRun,
    isGjcSessionActive,
    steerGjcRun,
    getPendingGjcApprovalsForSession,
    getGjcWorkerSupervisor,
    resolveGjcToolApproval,
    shutdownGjcWorker,
    spawnGjcRun,
} from './gjc-worker-client.js';
import { getProductionJobAuthority, getProductionJobOrchestrator } from './services/gjc-job-orchestrator.js';
import { readSessionLocation, resolveSessionWorkspacePath, validateSessionRepository } from './services/session-worktree-paths.js';
import { abortSessionWorktreeRun, prepareSessionWorktreeRun, sessionWorktreeWorkerHandle } from './services/session-worktree-runtime.js';
import { getProductionGjcJobGitService } from './services/gjc-job-git.service.js';
import {
    stripAnsiSequences,
    normalizeDetectedUrl,
    extractUrlsFromText,
    shouldAutoOpenUrlFromOutput,
} from './utils/url-detection.js';
import gitRoutes from './routes/git.js';
import authRoutes from './routes/auth.js';
import settingsRoutes from './routes/settings.js';
import { createGjcAppFactory } from './app-factory.js';
import { DesktopUpdateRelay } from './services/desktop-update-relay.js';
import { isWorkspaceRoot } from './modules/projects/index.js';
import projectModuleRoutes from './modules/projects/projects.routes.js';
import notificationRoutes from './modules/notifications/notifications.routes.js';
import userRoutes from './routes/user.js';
import systemRoutes from './routes/system.js';
import providerRoutes from './modules/providers/provider.routes.js';
import voiceRoutes from './voice-proxy.js';
import { assetsRoutes } from './modules/assets/index.js';
import { initializeDatabase, projectsDb, sessionsDb } from './modules/database/index.js';
import {
    automationRoutes,
    automationService,
    createBrowserAutomationRouter,
    handleBrowserConnection,
} from './modules/automation/index.js';
import { validateApiKey, authenticateToken, authenticateWebSocket } from './middleware/auth.js';
import { c } from './utils/colors.js';
import { evaluateExposure } from './utils/exposure-guard.js';

const __dirname = getModuleDir(import.meta.url);
// The server source runs from /server, while the compiled output runs from /dist-server/server.
// Resolving the app root once keeps every repo-level lookup below aligned across both layouts.
const APP_ROOT = findAppRoot(__dirname);
// Version of the server process, captured once for the health endpoint.
const RUNNING_VERSION = (() => {
    try {
        return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version || null;
    } catch {
        return null;
    }
})();
const MAX_FILE_UPLOAD_SIZE_MB = 200;
const MAX_FILE_UPLOAD_SIZE_BYTES = MAX_FILE_UPLOAD_SIZE_MB * 1024 * 1024;
const MAX_FILE_UPLOAD_COUNT = 20;

console.log('SERVER_PORT from env:', process.env.SERVER_PORT);

function readUsageNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function resolveProviderToolApproval(requestId, decision) {
    resolveGjcToolApproval(requestId, decision);
}

function getPendingProviderApprovalsForSession(sessionId) {
    return getPendingGjcApprovalsForSession(sessionId);
}

const gjcJobAuthority = getProductionJobAuthority();
configureSessionWorktrees({ validateRepository: validateSessionRepository, readLocation: readSessionLocation, resolveWorkspace: resolveSessionWorkspacePath });
const gjcJobOrchestrator = getProductionJobOrchestrator();
const gjcJobProjection = new GjcJobProjectionService({
    get: (params) => gjcJobAuthority.get(params),
    replayEvents: (params) => gjcJobAuthority.replayEvents(params),
});
const gjcTerminalNotificationAdapter = createGjcTerminalNotificationAdapter({
    authority: gjcJobAuthority,
});
function gjcSpawn(message, options, writer) {
    return spawnGjcRun(message, {
        ...options,
        cwd: options.projectPath ?? options.cwd,
    }, writer);
}

async function abortGjcChatRun(runId) {
    const result = await abortGjcRun(runId);
    if (result === 'not_started' || result === 'aborted') return true;
    // 'unconfirmed' also covers a run that settled between the stop request and
    // the worker call. A run the worker no longer tracks needs no abort, so
    // report the stop as satisfied instead of raising ABORT_FAILED on a race
    // the user cannot act on.
    return !isGjcSessionActive(runId);
}

function steerGjcChatRun(runId, message) {
    return steerGjcRun(runId, message);
}

const { app, server, wss } = createGjcAppFactory({
    desktopUpdateRelay: new DesktopUpdateRelay(),
    authority: gjcJobAuthority,
    orchestrator: gjcJobOrchestrator,
    gitService: getProductionGjcJobGitService(
        gjcJobAuthority,
        (jobId, eventId, payload) => gjcJobOrchestrator.appendAdminEvent(jobId, eventId, payload),
    ),
    projection: gjcJobProjection,
    terminalNotificationAdapter: gjcTerminalNotificationAdapter,
    authenticateWebSocket,
    authenticateGjcRoute: authenticateToken,
    validateApiKey,
    chat: {
        spawnFns: {
            gjc: gjcSpawn,
        },
        abortFns: {
            gjc: abortGjcChatRun,
        },
        steerFns: {
            gjc: steerGjcChatRun,
        },
        resolveToolApproval: resolveProviderToolApproval,
        getPendingApprovalsForSession: getPendingProviderApprovalsForSession,
        oauthSupervisor: getGjcWorkerSupervisor(),
        goalSupervisor: getGjcWorkerSupervisor(),
        gjcProjection: gjcJobProjection,
        sessionWorktrees: { prepare: prepareSessionWorktreeRun, abort: abortSessionWorktreeRun, workerHandle: sessionWorktreeWorkerHandle, resolveWorkspace: resolveSessionWorkspacePath },
    },
    shell: {
        resolveProviderSessionId: (sessionId, provider) => {
            const dbSession = sessionsDb.getSessionById(sessionId);
            if (dbSession) {
                return dbSession.provider_session_id ?? null;
            }
            return null;
        },
        stripAnsiSequences,
        normalizeDetectedUrl,
        extractUrlsFromText,
        shouldAutoOpenUrlFromOutput,
    },
    browser: handleBrowserConnection,
});

// Public health check endpoint (no authentication required)
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        product: 'gajae-app',
        protocolVersion: 1,
        timestamp: new Date().toISOString(),
        version: RUNNING_VERSION
    });
});

// Authentication routes (public)
app.use('/api/auth', authRoutes);

// Projects API Routes (protected)
app.use('/api/projects', authenticateToken, projectModuleRoutes);

// Chat image asset upload/serving (global ~/.gajae-app/assets store, protected)
app.use('/api/assets', authenticateToken, assetsRoutes);

// Git API Routes (protected)
app.use('/api/git', authenticateToken, gitRoutes);

// Settings API Routes (protected)
app.use('/api/settings', authenticateToken, settingsRoutes);

app.use('/api/notifications', authenticateToken, notificationRoutes);

// User API Routes (protected)
app.use('/api/user', authenticateToken, userRoutes);

// Host integration (protected): open files in the user's own editor.
app.use('/api/system', authenticateToken, systemRoutes);

// Unified provider MCP routes (protected)
app.use('/api/providers', authenticateToken, providerRoutes);

// Chromium/CDP and CUA Driver automation. The app factory's desktop guard and
// the normal owner authentication both run before these routes.
app.use('/api/automation', authenticateToken, automationRoutes);
app.use('/api/browser', authenticateToken, createBrowserAutomationRouter());

// Agent API Routes (uses API key authentication)

app.use('/api/voice', authenticateToken, voiceRoutes);

// Serve public files (like api-docs.html)
app.use(express.static(path.join(APP_ROOT, 'public')));

// Static files served after API routes
// Add cache control: HTML files should not be cached, but assets can be cached
app.use(express.static(path.join(APP_ROOT, 'dist'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            // Prevent HTML caching to avoid service worker issues after builds
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        } else if (filePath.match(/\.(js|css|woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico)$/)) {
            // Cache static assets for 1 year (they have hashed names)
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
    }
}));

// API Routes (protected)
// /api/config endpoint removed - no longer needed
// Frontend now uses window.location for WebSocket URLs


const expandWorkspacePath = (inputPath) => {
    if (!inputPath) return inputPath;
    if (inputPath === '~') {
        return WORKSPACES_ROOT;
    }
    if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
        return path.join(WORKSPACES_ROOT, inputPath.slice(2));
    }
    return inputPath;
};

// Browse filesystem endpoint for project suggestions - uses existing getFileTree
app.get('/api/browse-filesystem', authenticateToken, async (req, res) => {
    try {
        const { path: dirPath } = req.query;

        console.log('[API] Browse filesystem request for path:', dirPath);
        console.log('[API] WORKSPACES_ROOT is:', WORKSPACES_ROOT);
        // Default to home directory if no path provided
        const defaultRoot = WORKSPACES_ROOT;
        let targetPath = dirPath ? expandWorkspacePath(dirPath) : defaultRoot;

        // Resolve and normalize the path
        targetPath = path.resolve(targetPath);

        // Security check - ensure path is within allowed workspace root
        const validation = await validateWorkspacePath(targetPath);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }
        const resolvedPath = validation.resolvedPath || targetPath;

        // Security check - ensure path is accessible
        try {
            await fs.promises.access(resolvedPath);
            const stats = await fs.promises.stat(resolvedPath);

            if (!stats.isDirectory()) {
                return res.status(400).json({ error: 'Path is not a directory' });
            }
        } catch (err) {
            return res.status(404).json({ error: 'Directory not accessible' });
        }

        // Use existing getFileTree function with shallow depth (only direct children)
        const fileTree = await getFileTree(resolvedPath, 1, 0, false); // maxDepth=1, showHidden=false

        // Filter only directories and format for suggestions
        const directories = fileTree
            .filter(item => item.type === 'directory')
            .map(item => ({
                path: item.path,
                name: item.name,
                type: 'directory'
            }))
            .sort((a, b) => {
                const aHidden = a.name.startsWith('.');
                const bHidden = b.name.startsWith('.');
                if (aHidden && !bHidden) return 1;
                if (!aHidden && bHidden) return -1;
                return a.name.localeCompare(b.name);
            });

        // Add common directories if browsing home directory
        const suggestions = [];
        let resolvedWorkspaceRoot = defaultRoot;
        try {
            resolvedWorkspaceRoot = await fsPromises.realpath(defaultRoot);
        } catch (error) {
            // Use default root as-is if realpath fails
        }
        if (resolvedPath === resolvedWorkspaceRoot) {
            const commonDirs = ['Desktop', 'Documents', 'Projects', 'Development', 'Dev', 'Code', 'workspace'];
            const existingCommon = directories.filter(dir => commonDirs.includes(dir.name));
            const otherDirs = directories.filter(dir => !commonDirs.includes(dir.name));

            suggestions.push(...existingCommon, ...otherDirs);
        } else {
            suggestions.push(...directories);
        }

        res.json({
            path: resolvedPath,
            suggestions: suggestions
        });

    } catch (error) {
        console.error('Error browsing filesystem:', error);
        res.status(500).json({ error: 'Failed to browse filesystem' });
    }
});

app.post('/api/create-folder', authenticateToken, async (req, res) => {
    try {
        const { path: folderPath } = req.body;
        if (!folderPath) {
            return res.status(400).json({ error: 'Path is required' });
        }
        const expandedPath = expandWorkspacePath(folderPath);
        const resolvedInput = path.resolve(expandedPath);
        const validation = await validateWorkspacePath(resolvedInput);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }
        const targetPath = validation.resolvedPath || resolvedInput;
        const parentDir = path.dirname(targetPath);
        try {
            await fs.promises.access(parentDir);
        } catch (err) {
            return res.status(404).json({ error: 'Parent directory does not exist' });
        }
        try {
            await fs.promises.access(targetPath);
            return res.status(409).json({ error: 'Folder already exists' });
        } catch (err) {
            // Folder doesn't exist, which is what we want
        }
        try {
            await fs.promises.mkdir(targetPath, { recursive: false });
            res.json({ success: true, path: targetPath });
        } catch (mkdirError) {
            if (mkdirError.code === 'EEXIST') {
                return res.status(409).json({ error: 'Folder already exists' });
            }
            throw mkdirError;
        }
    } catch (error) {
        console.error('Error creating folder:', error);
        res.status(500).json({ error: 'Failed to create folder' });
    }
});

// Read file content endpoint
app.get('/api/projects/:projectId/file', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const { filePath } = req.query;


        // Security: ensure the requested path is inside the project root
        if (!filePath) {
            return res.status(400).json({ error: 'Invalid file path' });
        }

        // Resolve the absolute project root via the DB-backed helper; the
        // caller passes the DB-assigned `projectId`, not a folder name.
        const projectRoot = await resolveSessionWorkspacePath(projectId, req.query.sessionId);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Handle both absolute and relative paths.
        const resolved = path.isAbsolute(filePath)
            ? path.resolve(filePath)
            : path.resolve(projectRoot, filePath);
        const normalizedRoot = path.resolve(projectRoot) + path.sep;
        if (!resolved.startsWith(normalizedRoot)) {
            return res.status(403).json({ error: 'Path must be under project root' });
        }

        const readablePath = await resolveProjectFileForRead(projectRoot, resolved);
        if (!readablePath) {
            return res.status(403).json({ error: 'Path must be under project root' });
        }

        const content = await fsPromises.readFile(readablePath, 'utf8');
        res.json({ content, path: readablePath });
    } catch (error) {
        console.error('Error reading file:', error);
        if (error.statusCode) {
            res.status(error.statusCode).json({ error: error.message, code: error.code });
        } else if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'File not found' });
        } else if (error.code === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// Serve raw file bytes for previews and downloads.
app.get('/api/projects/:projectId/files/content', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const { path: filePath } = req.query;


        // Security: ensure the requested path is inside the project root
        if (!filePath) {
            return res.status(400).json({ error: 'Invalid file path' });
        }

        // Projects are now addressed by DB `projectId`, resolved to their path here.
        const projectRoot = await resolveSessionWorkspacePath(projectId, req.query.sessionId);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Match the text reader endpoint so callers can pass either project-relative
        // or absolute paths without changing how the bytes are served.
        const resolved = path.isAbsolute(filePath)
            ? path.resolve(filePath)
            : path.resolve(projectRoot, filePath);
        const normalizedRoot = path.resolve(projectRoot) + path.sep;
        if (!resolved.startsWith(normalizedRoot)) {
            return res.status(403).json({ error: 'Path must be under project root' });
        }

        const readablePath = await resolveProjectFileForRead(projectRoot, resolved);
        if (!readablePath) {
            return res.status(403).json({ error: 'Path must be under project root' });
        }

        // Check if file exists
        try {
            await fsPromises.access(readablePath);
        } catch (error) {
            return res.status(404).json({ error: 'File not found' });
        }

        // Get file extension and set appropriate content type
        const mimeType = mime.lookup(readablePath) || 'application/octet-stream';
        res.setHeader('Content-Type', mimeType);

        // Stream the file
        const fileStream = fs.createReadStream(readablePath);
        fileStream.pipe(res);

        fileStream.on('error', (error) => {
            console.error('Error streaming file:', error);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Error reading file' });
            }
        });

    } catch (error) {
        console.error('Error serving binary file:', error);
        if (!res.headersSent) {
            res.status(error.statusCode || 500).json({ error: error.message });
        }
    }
});

// Save file content endpoint
app.put('/api/projects/:projectId/file', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const { filePath, content } = req.body;


        // Security: ensure the requested path is inside the project root
        if (!filePath) {
            return res.status(400).json({ error: 'Invalid file path' });
        }

        if (typeof content !== 'string') {
            return res.status(400).json({ error: 'Content must be a string' });
        }

        // Projects are now addressed by DB `projectId`, resolved to their path here.
        const projectRoot = await projectsDb.getProjectPathById(projectId);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Handle both absolute and relative paths.
        const resolved = path.isAbsolute(filePath)
            ? path.resolve(filePath)
            : path.resolve(projectRoot, filePath);
        const normalizedRoot = path.resolve(projectRoot) + path.sep;
        if (!resolved.startsWith(normalizedRoot)) {
            return res.status(403).json({ error: 'Path must be under project root' });
        }

        const writableFile = await openProjectFileForWrite(projectRoot, resolved);
        if (!writableFile) {
            return res.status(403).json({ error: 'Path must be a regular file under project root' });
        }

        let currentStats;
        try {
            currentStats = await writableFile.handle.stat();
        } finally {
            await writableFile.handle.close();
        }

        const temporaryPath = path.join(
            path.dirname(writableFile.path),
            `.${path.basename(writableFile.path)}.${randomUUID()}.tmp`
        );
        let temporaryHandle;
        try {
            temporaryHandle = await fsPromises.open(temporaryPath, 'wx', currentStats.mode);
            await temporaryHandle.writeFile(content, 'utf8');
            await temporaryHandle.sync();
            await temporaryHandle.close();
            temporaryHandle = null;
            await fsPromises.rename(temporaryPath, writableFile.path);
        } finally {
            await temporaryHandle?.close().catch(() => {});
            await fsPromises.rm(temporaryPath, { force: true }).catch(() => {});
        }

        res.json({
            success: true,
            path: writableFile.path,
            message: 'File saved successfully'
        });
    } catch (error) {
        console.error('Error saving file:', error);
        if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'File or directory not found' });
        } else if (error.code === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

app.get('/api/projects/:projectId/files', authenticateToken, async (req, res) => {
    try {

        // Using fsPromises from import

        // Resolve the project's absolute path through the DB (projectId is the
        // primary key of the `projects` table after the identifier migration).
        const actualPath = await resolveSessionWorkspacePath(req.params.projectId, req.query.sessionId);
        if (!actualPath) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Check if path exists
        try {
            await fsPromises.access(actualPath);
        } catch (e) {
            return res.status(404).json({ error: `Project path not found: ${actualPath}` });
        }

        // A workspace root (~/Projects: no repo of its own, dozens of child
        // repos) is where a session picks a child repo, not a tree to mention
        // files from. Walking it ten levels deep stats every file in every
        // repo and pins the event loop for minutes, so it lists the root's own
        // entries but does not open any child repo.
        const depth = (await isWorkspaceRoot(actualPath)) ? 0 : 10;
        const files = await getFileTree(actualPath, depth, 0, true);
        res.json(files);
    } catch (error) {
        console.error('[ERROR] File tree error:', error.message);
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

// ============================================================================
// FILE OPERATIONS API ENDPOINTS
// ============================================================================

/**
 * Validate that a path is within the project root
 * @param {string} projectRoot - The project root path
 * @param {string} targetPath - The path to validate
 * @returns {{ valid: boolean, resolved?: string, error?: string }}
 */
async function validatePathInProject(projectRoot, targetPath) {
    const resolved = path.isAbsolute(targetPath)
        ? path.resolve(targetPath)
        : path.resolve(projectRoot, targetPath);
    const canonicalPath = await resolveProjectFileForWrite(projectRoot, resolved);
    if (!canonicalPath) {
        return { valid: false, error: 'Path must be under project root' };
    }
    return { valid: true, resolved: canonicalPath };
}

/**
 * Validate filename - check for invalid characters
 * @param {string} name - The filename to validate
 * @returns {{ valid: boolean, error?: string }}
 */
function validateFilename(name) {
    if (!name || !name.trim()) {
        return { valid: false, error: 'Filename cannot be empty' };
    }
    // Check for invalid characters (Windows + Unix)
    const invalidChars = /[<>:"/\\|?*\x00-\x1f]/;
    if (invalidChars.test(name)) {
        return { valid: false, error: 'Filename contains invalid characters' };
    }
    // Check for reserved names (Windows)
    const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
    if (reserved.test(name)) {
        return { valid: false, error: 'Filename is a reserved name' };
    }
    // Check for dots only
    if (/^\.+$/.test(name)) {
        return { valid: false, error: 'Filename cannot be only dots' };
    }
    return { valid: true };
}

// POST /api/projects/:projectId/files/create - Create new file or directory
app.post('/api/projects/:projectId/files/create', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const { path: parentPath, type, name } = req.body;

        // Validate input
        if (!name || !type) {
            return res.status(400).json({ error: 'Name and type are required' });
        }

        if (!['file', 'directory'].includes(type)) {
            return res.status(400).json({ error: 'Type must be "file" or "directory"' });
        }

        const nameValidation = validateFilename(name);
        if (!nameValidation.valid) {
            return res.status(400).json({ error: nameValidation.error });
        }

        // Resolve the project directory through the DB using the new projectId.
        const projectRoot = await projectsDb.getProjectPathById(projectId);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Build and validate target path
        const targetDir = parentPath || '';
        const targetPath = targetDir ? path.join(targetDir, name) : name;
        const validation = await validatePathInProject(projectRoot, targetPath);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }

        const resolvedPath = validation.resolved;

        // Check if already exists
        try {
            await fsPromises.access(resolvedPath);
            return res.status(409).json({ error: `${type === 'file' ? 'File' : 'Directory'} already exists` });
        } catch {
            // Doesn't exist, which is what we want
        }

        // Create file or directory
        if (type === 'directory') {
            await fsPromises.mkdir(resolvedPath, { recursive: false });
        } else {
            // Ensure parent directory exists
            const parentDir = path.dirname(resolvedPath);
            try {
                await fsPromises.access(parentDir);
            } catch {
                await fsPromises.mkdir(parentDir, { recursive: true });
            }
            const fileHandle = await fsPromises.open(resolvedPath, 'wx');
            await fileHandle.close();
        }

        res.json({
            success: true,
            path: resolvedPath,
            name,
            type,
            message: `${type === 'file' ? 'File' : 'Directory'} created successfully`
        });
    } catch (error) {
        console.error('Error creating file/directory:', error);
        if (error.code === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'Parent directory not found' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// PUT /api/projects/:projectId/files/rename - Rename file or directory
app.put('/api/projects/:projectId/files/rename', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const { oldPath, newName } = req.body;

        // Validate input
        if (!oldPath || !newName) {
            return res.status(400).json({ error: 'oldPath and newName are required' });
        }

        const nameValidation = validateFilename(newName);
        if (!nameValidation.valid) {
            return res.status(400).json({ error: nameValidation.error });
        }

        // Resolve the project directory through the DB using the new projectId.
        const projectRoot = await projectsDb.getProjectPathById(projectId);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Canonicalize the parent while preserving the leaf, so an in-project
        // symlink is renamed rather than its target.
        const resolvedOldPath = await resolveProjectEntryForMutation(projectRoot, oldPath);
        if (!resolvedOldPath) {
            return res.status(403).json({ error: 'Path must be under project root' });
        }

        try {
            await fsPromises.lstat(resolvedOldPath);
        } catch (error) {
            if (error.code === 'ENOENT') {
                return res.status(404).json({ error: 'File or directory not found' });
            }
            throw error;
        }

        // Build and validate new path
        const parentDir = path.dirname(resolvedOldPath);
        const resolvedNewPath = path.join(parentDir, newName);
        const newValidation = await resolveProjectEntryForMutation(projectRoot, resolvedNewPath);
        if (resolvedOldPath === await fsPromises.realpath(projectRoot)) {
            return res.status(403).json({ error: 'Cannot rename project root directory' });
        }
        if (!newValidation) {
            return res.status(403).json({ error: 'Path must be under project root' });
        }

        // Check if the destination entry already exists without following it.
        try {
            await fsPromises.lstat(newValidation);
            return res.status(409).json({ error: 'A file or directory with this name already exists' });
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }

        // Rename
        await fsPromises.rename(resolvedOldPath, newValidation);

        res.json({
            success: true,
            oldPath: resolvedOldPath,
            newPath: newValidation,
            newName,
            message: 'Renamed successfully'
        });
    } catch (error) {
        console.error('Error renaming file/directory:', error);
        if (error.code === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'File or directory not found' });
        } else if (error.code === 'EXDEV') {
            res.status(400).json({ error: 'Cannot move across different filesystems' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// DELETE /api/projects/:projectId/files - Delete file or directory
app.delete('/api/projects/:projectId/files', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const { path: targetPath } = req.body;

        // Validate input
        if (!targetPath) {
            return res.status(400).json({ error: 'Path is required' });
        }

        // Resolve the project directory through the DB using the new projectId.
        const projectRoot = await projectsDb.getProjectPathById(projectId);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Preserve the final directory entry so deleting an in-project symlink
        // removes only the link, never the target it references.
        const resolvedPath = await resolveProjectEntryForMutation(projectRoot, targetPath);
        if (!resolvedPath) {
            return res.status(403).json({ error: 'Path must be under project root' });
        }

        let stats;
        try {
            stats = await fsPromises.lstat(resolvedPath);
        } catch (error) {
            if (error.code === 'ENOENT') {
                return res.status(404).json({ error: 'File or directory not found' });
            }
            throw error;
        }

        // Prevent deleting the project root itself
        if (resolvedPath === await fsPromises.realpath(projectRoot)) {
            return res.status(403).json({ error: 'Cannot delete project root directory' });
        }

        // Delete based on type
        if (stats.isDirectory() && !stats.isSymbolicLink()) {
            await fsPromises.rm(resolvedPath, { recursive: true, force: true });
        } else {
            await fsPromises.unlink(resolvedPath);
        }

        res.json({
            success: true,
            path: resolvedPath,
            type: stats.isDirectory() ? 'directory' : 'file',
            message: 'Deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting file/directory:', error);
        if (error.code === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'File or directory not found' });
        } else if (error.code === 'ENOTEMPTY') {
            res.status(400).json({ error: 'Directory is not empty' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// POST /api/projects/:projectId/files/upload - Upload files
// Dynamic import of multer for file uploads
const uploadFilesHandler = async (req, res) => {
    // Dynamic import of multer
    const multer = (await import('multer')).default;
    const uploadStagingRoot = path.join(os.tmpdir(), 'gajae-app-uploads');
    await fsPromises.mkdir(uploadStagingRoot, { recursive: true, mode: 0o700 });
    await fsPromises.chmod(uploadStagingRoot, 0o700);
    const stagingDir = await fsPromises.mkdtemp(path.join(uploadStagingRoot, 'request-'));
    await fsPromises.chmod(stagingDir, 0o700);

    const uploadMiddleware = multer({
        storage: multer.diskStorage({
            destination: (req, file, cb) => {
                cb(null, stagingDir);
            },
            filename: (req, file, cb) => {
                // Use a unique temp name, but preserve original name in file.originalname
                // Note: file.originalname may contain path separators for folder uploads
                const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
                // For temp file, just use a safe unique name without the path
                cb(null, `upload-${uniqueSuffix}`);
            }
        }),
        limits: {
            fileSize: MAX_FILE_UPLOAD_SIZE_BYTES,
            files: MAX_FILE_UPLOAD_COUNT
        }
    });

    // Await the middleware callback so the private staging directory always has
    // a single cleanup owner, including parser and validation failures.
    await new Promise((resolve) => {
        uploadMiddleware.array('files', MAX_FILE_UPLOAD_COUNT)(req, res, async (err) => {
        try {
            if (err) {
                console.error('Multer error:', err);
                if (err.code === 'LIMIT_FILE_SIZE') {
                    return res.status(400).json({ error: `File too large. Maximum size is ${MAX_FILE_UPLOAD_SIZE_MB}MB.` });
                }
                if (err.code === 'LIMIT_FILE_COUNT') {
                    return res.status(400).json({ error: `Too many files. Maximum is ${MAX_FILE_UPLOAD_COUNT} files.` });
                }
                return res.status(500).json({ error: err.message });
            }
            const { projectId } = req.params;
            const { targetPath, relativePaths, requestedFileCount: requestedFileCountRaw } = req.body;

            // Parse relative paths if provided (for folder uploads)
            let filePaths = [];
            if (relativePaths) {
                try {
                    filePaths = JSON.parse(relativePaths);
                } catch (e) {
                    console.log('[DEBUG] Failed to parse relativePaths:', relativePaths);
                }
            }

            console.log('[DEBUG] File upload request:', {
                projectId,
                targetPath: JSON.stringify(targetPath),
                targetPathType: typeof targetPath,
                filesCount: req.files?.length,
                relativePaths: filePaths
            });

            if (!req.files || req.files.length === 0) {
                return res.status(400).json({ error: 'No files provided' });
            }

            const parsedRequestedFileCount = Number.parseInt(requestedFileCountRaw, 10);
            const requestedFileCount = Number.isFinite(parsedRequestedFileCount) && parsedRequestedFileCount > 0
                ? parsedRequestedFileCount
                : req.files.length;

            // Resolve the project directory through the DB using the new projectId.
            const projectRoot = await projectsDb.getProjectPathById(projectId);
            if (!projectRoot) {
                return res.status(404).json({ error: 'Project not found' });
            }

            console.log('[DEBUG] Project root:', projectRoot);

            // Validate and resolve target path
            // If targetPath is empty or '.', use project root directly
            const targetDir = targetPath || '';
            let resolvedTargetDir;

            console.log('[DEBUG] Target dir:', JSON.stringify(targetDir));

            if (!targetDir || targetDir === '.' || targetDir === './') {
                // Empty path means upload to project root
                resolvedTargetDir = await resolveProjectFileForWrite(projectRoot, projectRoot);
                console.log('[DEBUG] Using project root as target:', resolvedTargetDir);
            } else {
                const validation = await validatePathInProject(projectRoot, targetDir);
                if (!validation.valid) {
                    console.log('[DEBUG] Path validation failed:', validation.error);
                    return res.status(403).json({ error: validation.error });
                }
                resolvedTargetDir = validation.resolved;
                console.log('[DEBUG] Resolved target dir:', resolvedTargetDir);
            }
            if (!resolvedTargetDir) {
                return res.status(403).json({ error: 'Path must be under project root' });
            }

            // Ensure target directory exists
            try {
                await fsPromises.access(resolvedTargetDir);
            } catch {
                await fsPromises.mkdir(resolvedTargetDir, { recursive: true });
            }
            resolvedTargetDir = await resolveProjectFileForWrite(projectRoot, resolvedTargetDir);
            if (!resolvedTargetDir) {
                return res.status(403).json({ error: 'Path must be under project root' });
            }

            // Move uploaded files from temp to target directory
            const uploadedFiles = [];
            console.log('[DEBUG] Processing files:', req.files.map(f => ({ originalname: f.originalname, path: f.path })));
            for (let i = 0; i < req.files.length; i++) {
                const file = req.files[i];
                // Use relative path if provided (for folder uploads), otherwise use originalname
                const fileName = (filePaths && filePaths[i]) ? filePaths[i] : file.originalname;
                console.log('[DEBUG] Processing file:', fileName, '(originalname:', file.originalname + ')');
                const destPath = path.join(resolvedTargetDir, fileName);

                // Validate destination path
                const destValidation = await validatePathInProject(projectRoot, destPath);
                if (!destValidation.valid) {
                    console.log('[DEBUG] Destination validation failed for:', destPath);
                    continue;
                }

                // Ensure parent directory exists (for nested files from folder upload)
                const parentDir = path.dirname(destValidation.resolved);
                try {
                    await fsPromises.access(parentDir);
                } catch {
                    await fsPromises.mkdir(parentDir, { recursive: true });
                }

                // Move file (copy + unlink to handle cross-device scenarios)
                const canonicalDestination = await resolveProjectFileForWrite(projectRoot, destValidation.resolved);
                if (!canonicalDestination) {
                    continue;
                }
                await fsPromises.copyFile(file.path, canonicalDestination, fs.constants.COPYFILE_EXCL);
                await fsPromises.unlink(file.path);

                uploadedFiles.push({
                    name: fileName,
                    path: canonicalDestination,
                    size: file.size,
                    mimeType: file.mimetype
                });
            }

            res.json({
                success: true,
                files: uploadedFiles,
                uploadedCount: uploadedFiles.length,
                requestedFileCount,
                targetPath: resolvedTargetDir,
                message: `Uploaded ${uploadedFiles.length} ${uploadedFiles.length === 1 ? 'file' : 'files'} successfully`
            });
        } catch (error) {
            console.error('Error uploading files:', error);
            if (error.code === 'EACCES') {
                res.status(403).json({ error: 'Permission denied' });
            } else {
                res.status(500).json({ error: error.message });
            }
        } finally {
            try {
                await fsPromises.rm(stagingDir, { recursive: true, force: true });
            } catch (cleanupError) {
                console.error('Failed to clean upload staging directory:', cleanupError);
            }
            resolve();
        }
        });
    });
};

app.post('/api/projects/:projectId/files/upload', authenticateToken, uploadFilesHandler);

// Chat image uploads moved to POST /api/assets/images (server/modules/assets),
// which stores them in the global ~/.gajae-app/assets folder.

// Get token usage for a specific session. `projectId` is the DB primary key;
// the Claude branch below resolves it to an absolute path via the DB.
app.get('/api/projects/:projectId/sessions/:sessionId/token-usage', authenticateToken, async (req, res) => {
    try {
        const { projectId, sessionId } = req.params;
        const homeDir = os.homedir();

        // Allow only safe characters in sessionId
        const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9._-]/g, '');
        if (!safeSessionId || safeSessionId !== String(sessionId)) {
            return res.status(400).json({ error: 'Invalid sessionId' });
        }

        // Provider artifacts on disk (JSONL file names, OpenCode sqlite rows)
        // are keyed by the provider-native session id, while the caller sends
        // the app-facing id. Resolve provider and id mapping from the indexed
        // session row so the frontend does not choose provider-specific paths.
        const sessionRow = sessionsDb.getSessionById(safeSessionId);
        if (!sessionRow) {
            return res.status(404).json({ error: 'Session not found', sessionId: safeSessionId });
        }

        // Historical non-GJC sessions keep their provider value; the
        // transcript branches below only serve those read-only rows.
        const provider = sessionRow.provider || 'gjc';
        const providerNativeSessionId = sessionRow?.provider_session_id || safeSessionId;

        // Handle Cursor sessions - they use SQLite and don't have token usage info
        if (provider === 'cursor') {
            return res.json({
                used: 0,
                total: 0,
                inputTokens: 0,
                outputTokens: 0,
                breakdown: { input: 0, output: 0 },
                unsupported: true,
                message: 'Token usage tracking not available for Cursor sessions'
            });
        }

        if (provider === 'opencode') {
            const dbPath = getOpenCodeDatabasePath();
            if (!fs.existsSync(dbPath)) {
                return res.status(404).json({ error: 'OpenCode database not found' });
            }

            const db = new Database(dbPath, { readonly: true, fileMustExist: true });
            try {
                const columns = db.prepare('PRAGMA table_info(session)').all();
                const columnNames = new Set(columns.map((column) => column.name));
                const requiredColumns = ['tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read', 'tokens_cache_write'];
                if (!requiredColumns.every((column) => columnNames.has(column))) {
                    return res.json({
                        used: 0,
                        inputTokens: 0,
                        outputTokens: 0,
                        breakdown: { input: 0, output: 0 },
                        unsupported: true,
                        message: 'Token usage tracking is not available in this OpenCode database schema'
                    });
                }

                const row = db.prepare(`
                    SELECT
                        tokens_input AS inputTokens,
                        tokens_output AS outputTokens,
                        tokens_reasoning AS reasoningTokens,
                        tokens_cache_read AS cacheReadTokens,
                        tokens_cache_write AS cacheWriteTokens
                    FROM session
                    WHERE id = ?
                `).get(providerNativeSessionId);

                if (!row) {
                    return res.status(404).json({ error: 'OpenCode session not found', sessionId: safeSessionId });
                }

                const inputTokens = Number(row.inputTokens || 0) + Number(row.cacheReadTokens || 0);
                const outputTokens = Number(row.outputTokens || 0);
                const totalUsed = Number(row.inputTokens || 0)
                    + outputTokens
                    + Number(row.reasoningTokens || 0)
                    + Number(row.cacheReadTokens || 0)
                    + Number(row.cacheWriteTokens || 0);

                return res.json({
                    used: totalUsed,
                    inputTokens,
                    outputTokens,
                    breakdown: {
                        input: inputTokens,
                        output: outputTokens
                    }
                });
            } finally {
                db.close();
            }
        }

        // Handle Codex sessions
        if (provider === 'codex') {
            const codexSessionsDir = path.join(homeDir, '.codex', 'sessions');

            // Find the session file by searching for the session ID
            const findSessionFile = async (dir) => {
                try {
                    const entries = await fsPromises.readdir(dir, { withFileTypes: true });
                    for (const entry of entries) {
                        const fullPath = path.join(dir, entry.name);
                        if (entry.isDirectory()) {
                            const found = await findSessionFile(fullPath);
                            if (found) return found;
                        } else if (entry.name.includes(providerNativeSessionId) && entry.name.endsWith('.jsonl')) {
                            return fullPath;
                        }
                    }
                } catch (error) {
                    // Skip directories we can't read
                }
                return null;
            };

            const sessionFilePath = await findSessionFile(codexSessionsDir);

            if (!sessionFilePath) {
                return res.status(404).json({ error: 'Codex session file not found', sessionId: safeSessionId });
            }

            // Read and parse the Codex JSONL file
            let fileContent;
            try {
                fileContent = await fsPromises.readFile(sessionFilePath, 'utf8');
            } catch (error) {
                if (error.code === 'ENOENT') {
                    return res.status(404).json({ error: 'Session file not found', path: sessionFilePath });
                }
                throw error;
            }
            const lines = fileContent.trim().split('\n');
            let inputTokens = 0;
            let outputTokens = 0;
            let totalTokens = 0;
            let contextWindow = 200000; // Default for Codex/OpenAI

            // Find the latest token_count event with info (scan from end)
            for (let i = lines.length - 1; i >= 0; i--) {
                try {
                    const entry = JSON.parse(lines[i]);

                    // Codex stores token info in event_msg with type: "token_count"
                    if (entry.type === 'event_msg' && entry.payload?.type === 'token_count' && entry.payload?.info) {
                        const tokenInfo = entry.payload.info;
                        if (tokenInfo.total_token_usage) {
                            inputTokens = tokenInfo.total_token_usage.input_tokens || 0;
                            outputTokens = tokenInfo.total_token_usage.output_tokens || 0;
                            totalTokens = tokenInfo.total_token_usage.total_tokens || inputTokens + outputTokens;
                        }
                        if (tokenInfo.model_context_window) {
                            contextWindow = tokenInfo.model_context_window;
                        }
                        break; // Stop after finding the latest token count
                    }
                } catch (parseError) {
                    // Skip lines that can't be parsed
                    continue;
                }
            }

            return res.json({
                used: totalTokens,
                total: contextWindow,
                inputTokens,
                outputTokens,
                breakdown: {
                    input: inputTokens,
                    output: outputTokens
                }
            });
        }

        // Handle Claude sessions (default)
        // Resolve the project path through the DB using the caller-supplied
        // `projectId`. Legacy code here called extractProjectDirectory with a
        // folder-encoded project name; the migration centralizes that lookup
        // in the projects table.
        const projectPath = await projectsDb.getProjectPathById(projectId);
        if (!projectPath) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Construct the JSONL file path
        // Claude stores session files in ~/.claude/projects/[encoded-project-path]/[session-id].jsonl
        // The encoding replaces any non-alphanumeric character (except -) with -
        const encodedPath = projectPath.replace(/[^a-zA-Z0-9-]/g, '-');
        const projectDir = path.join(homeDir, '.claude', 'projects', encodedPath);

        // Prefer the indexed transcript path (already produced by the trusted
        // session synchronizer); fall back to the conventional location
        // derived from the provider-native session id.
        let jsonlPath = sessionRow?.jsonl_path;
        if (!jsonlPath) {
            jsonlPath = path.join(projectDir, `${providerNativeSessionId}.jsonl`);

            // Constrain the constructed path to projectDir (the id is
            // caller-influenced in this fallback branch).
            const rel = path.relative(path.resolve(projectDir), path.resolve(jsonlPath));
            if (rel.startsWith('..') || path.isAbsolute(rel)) {
                return res.status(400).json({ error: 'Invalid path' });
            }
        }

        // Read and parse the JSONL file
        let fileContent;
        try {
            fileContent = await fsPromises.readFile(jsonlPath, 'utf8');
        } catch (error) {
            if (error.code === 'ENOENT') {
                return res.status(404).json({ error: 'Session file not found', path: jsonlPath });
            }
            throw error; // Re-throw other errors to be caught by outer try-catch
        }
        const lines = fileContent.trim().split('\n');

        const parsedContextWindow = parseInt(process.env.CONTEXT_WINDOW, 10);
        const contextWindow = Number.isFinite(parsedContextWindow) ? parsedContextWindow : 160000;
        let inputTokens = 0;
        let outputTokens = 0;
        let cacheReadTokens = 0;
        let cacheCreationTokens = 0;

        // Find the latest assistant message with usage data (scan from end)
        for (let i = lines.length - 1; i >= 0; i--) {
            try {
                const entry = JSON.parse(lines[i]);

                // Only count assistant messages which have usage data
                if (entry.type === 'assistant' && entry.message?.usage) {
                    const usage = entry.message.usage;

                    // Use token counts from latest assistant message only
                    const directInputTokens = readUsageNumber(usage.input_tokens ?? usage.inputTokens);
                    cacheReadTokens = readUsageNumber(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? usage.cacheReadTokens);
                    cacheCreationTokens = readUsageNumber(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? usage.cacheCreationTokens);
                    inputTokens = directInputTokens + cacheReadTokens + cacheCreationTokens;
                    outputTokens = readUsageNumber(usage.output_tokens ?? usage.outputTokens);

                    break; // Stop after finding the latest assistant message
                }
            } catch (parseError) {
                // Skip lines that can't be parsed
                continue;
            }
        }

        const totalUsed = inputTokens + outputTokens;
        const cacheTokens = cacheReadTokens + cacheCreationTokens;

        res.json({
            used: totalUsed,
            total: contextWindow,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheCreationTokens,
            cacheTokens,
            breakdown: {
                input: inputTokens,
                output: outputTokens
            }
        });
    } catch (error) {
        console.error('Error reading session token usage:', error);
        res.status(500).json({ error: 'Failed to read session token usage' });
    }
});

// Serve React app for all other routes (excluding static files)
app.get('*', (req, res) => {
    // Skip requests for static assets (files with extensions)
    if (path.extname(req.path)) {
        return res.status(404).send('Not found');
    }

    // Only serve index.html for HTML routes, not for static assets
    // Static assets should already be handled by express.static middleware above
    const indexPath = path.join(APP_ROOT, 'dist', 'index.html');

    // Check if dist/index.html exists (production build available)
    if (fs.existsSync(indexPath)) {
        // Set no-cache headers for HTML to prevent service worker issues
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.sendFile(indexPath);
    } else {
        // In development, redirect to Vite dev server only if dist doesn't exist
        const redirectHost = getConnectableHost(req.hostname);
        res.redirect(`${req.protocol}://${redirectHost}:${VITE_PORT}`);
    }
});

// global error middleware must be last
app.use((err, req, res, next) => {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
  }

  console.error(err);

  return res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    },
  });
});

// Helper function to convert permissions to rwx format
function permToRwx(perm) {
    const r = perm & 4 ? 'r' : '-';
    const w = perm & 2 ? 'w' : '-';
    const x = perm & 1 ? 'x' : '-';
    return r + w + x;
}

// Directories that are almost never interesting for a project tree but can
// contain tens of thousands of files. Skipping them before recursion keeps
// traversal time bounded on large monorepos and high-latency filesystems
// (NFS / SMB).
const IGNORED_DIRS = new Set([
    // JS / TS toolchains
    'node_modules', 'dist', 'build', '.next', '.nuxt', '.cache', '.parcel-cache',
    // VCS
    '.git', '.svn', '.hg',
    // Python
    '__pycache__', '.pytest_cache', '.mypy_cache', '.tox', 'venv', '.venv',
    // Rust / Go / Java / Ruby
    'target', 'vendor',
    // Build output / IDE
    '.gradle', '.idea', 'coverage', '.nyc_output'
]);

const DEFAULT_FS_CONCURRENCY = 64;
const parsedFsConcurrency = Number.parseInt(process.env.FS_CONCURRENCY || '', 10);
const FS_CONCURRENCY = Number.isFinite(parsedFsConcurrency) && parsedFsConcurrency > 0
    ? parsedFsConcurrency
    : DEFAULT_FS_CONCURRENCY;
let activeFsOperations = 0;
const pendingFsOperations = [];

async function acquire() {
    if (activeFsOperations < FS_CONCURRENCY) {
        activeFsOperations += 1;
        return;
    }

    await new Promise((resolve) => {
        pendingFsOperations.push(resolve);
    });
}

function release() {
    const next = pendingFsOperations.shift();
    if (next) {
        next();
        return;
    }

    activeFsOperations = Math.max(0, activeFsOperations - 1);
}

async function getFileTree(dirPath, maxDepth = 3, currentDepth = 0, showHidden = true) {
    // Using fsPromises from import
    let entries;
    try {
        await acquire();
        try {
            entries = await fsPromises.readdir(dirPath, { withFileTypes: true });
        } finally {
            release();
        }
    } catch (error) {
        // Expected, non-actionable races and denials stay quiet:
        // - EACCES/EPERM: unreadable system dirs.
        // - ENOENT/ENOTDIR: the entry vanished (or was replaced by a file)
        //   between the parent's readdir and this recursion - routine for
        //   ephemeral artifacts like GJC session lock files.
        if (!['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR'].includes(error.code)) {
            console.error('Error reading directory:', error);
        }
        return [];
    }

    const filteredEntries = entries.filter((entry) => !(entry.isDirectory() && IGNORED_DIRS.has(entry.name)));

    // Process every entry in parallel. On high-latency filesystems (NFS/SMB)
    // serial stat() was the real bottleneck — issuing them concurrently lets
    // the kernel pipeline the round-trips and the recursive calls overlap too.
    const items = await Promise.all(filteredEntries.map(async (entry) => {
        const itemPath = path.join(dirPath, entry.name);
        const item = {
            name: entry.name,
            path: itemPath,
            type: entry.isDirectory() ? 'directory' : 'file'
        };

        // Get file stats for additional metadata
        try {
            await acquire();
            try {
              const stats = await fsPromises.lstat(itemPath);
              item.size = stats.size;
              item.modified = stats.mtime.toISOString();

              // Mark symlinks so UI can distinguish them
              if (stats.isSymbolicLink()) {
                item.isSymlink = true;
              }

              // Convert permissions to rwx format
              const mode = stats.mode;
              const ownerPerm = (mode >> 6) & 7;
              const groupPerm = (mode >> 3) & 7;
              const otherPerm = mode & 7;
              item.permissions =
                ((mode >> 6) & 7).toString() +
                ((mode >> 3) & 7).toString() +
                (mode & 7).toString();
              item.permissionsRwx =
                permToRwx(ownerPerm) +
                permToRwx(groupPerm) +
                permToRwx(otherPerm);
            } finally {
                release();
            }
        } catch (statError) {
            // If stat fails, provide default values
            item.size = 0;
            item.modified = null;
            item.permissions = '000';
            item.permissionsRwx = '---------';
        }

        if (entry.isDirectory() && currentDepth < maxDepth) {
            // Recurse. Let readdir's own EACCES bubble up through the catch in
            // the recursive call rather than doing a separate access() probe
            // (which doubled the round-trip count on SMB without adding info).
            // The recursive call starts with a bounded readdir; holding a permit
            // for the whole subtree can deadlock when sibling directories are
            // waiting on their own children.
            item.children = await getFileTree(itemPath, maxDepth, currentDepth + 1, showHidden);
        }

        return item;
    }));

    return items.sort((a, b) => {
        if (a.type !== b.type) {
            return a.type === 'directory' ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
    });
}

const SERVER_PORT = process.env.SERVER_PORT || 3001;
// Loopback by default (fail-closed): this UI can run shell commands, so network
// exposure must be an explicit choice (HOST env / --host) — see utils/exposure-guard.js.
const HOST = process.env.HOST || '127.0.0.1';
const DISPLAY_HOST = getConnectableHost(HOST);
const VITE_PORT = process.env.VITE_PORT || 5173;
const LOCAL_SERVER_MARKER_PATH = path.join(os.homedir(), '.gajae-app', 'local-server.json');

async function writeLocalServerMarker(port) {
    const marker = {
        pid: process.pid,
        host: HOST,
        port,
        url: `http://${DISPLAY_HOST}:${port}`,
        appRoot: APP_ROOT,
        updatedAt: new Date().toISOString(),
    };

    await fsPromises.mkdir(path.dirname(LOCAL_SERVER_MARKER_PATH), { recursive: true });
    await fsPromises.writeFile(LOCAL_SERVER_MARKER_PATH, JSON.stringify(marker, null, 2), 'utf8');
}

async function removeLocalServerMarker() {
    try {
        const raw = await fsPromises.readFile(LOCAL_SERVER_MARKER_PATH, 'utf8');
        const marker = JSON.parse(raw);
        if (marker.pid && marker.pid !== process.pid) return;
    } catch {
        return;
    }

    try {
        await fsPromises.unlink(LOCAL_SERVER_MARKER_PATH);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn('[WARN] Could not remove local server marker:', error.message);
        }
    }
}

// Initialize database and start server
async function startServer() {
    try {
        // Initialize authentication database
        await initializeDatabase();
        await automationService.startBridge();
        try {
            await gjcJobOrchestrator.reconcile();
        } catch (error) {
            console.error('[GJC Jobs] Authority reconciliation failed:', error?.message || error);
        }


        // Fail-closed exposure guard: desktop traffic stays on loopback unless
        // a trusted private-network override is explicitly configured.
        const exposure = evaluateExposure({
            host: HOST,
            allowUnauthRemote: process.env.GAJAE_ALLOW_UNAUTH_REMOTE === '1',
        });
        if (exposure.level === 'block') {
            console.error(`${c.warn('[SECURITY]')} ${exposure.message}`);
            process.exit(1);
        }
        if (exposure.level === 'warn') {
            console.warn(`${c.warn('[SECURITY]')} ${exposure.message}`);
        }

        // Check if running in production mode (dist folder exists)
        const distIndexPath = path.join(APP_ROOT, 'dist', 'index.html');
        const isProduction = fs.existsSync(distIndexPath);

        console.log('');

        if (isProduction) {
            console.log(`${c.info('[INFO]')} To run in production mode, go to http://${DISPLAY_HOST}:${SERVER_PORT}`);            
        }

        console.log(`${c.info('[INFO]')} To run in development mode with hot-module replacement, go to http://${DISPLAY_HOST}:${VITE_PORT}`);
   
        server.listen(SERVER_PORT, HOST, async () => {
            const address = server.address();
            const port = typeof address === 'object' && address ? address.port : Number.parseInt(String(SERVER_PORT), 10);
            const appRoot = APP_ROOT;
            await writeLocalServerMarker(port).catch((error) => {
                console.warn('[WARN] Could not write local server marker:', error.message);
            });

            if (process.env.GJC_DESKTOP === '1') {
                console.log(JSON.stringify({
                    kind: 'gajae-desktop-ready',
                    pid: process.pid,
                    host: HOST,
                    port,
                    protocolVersion: 1,
                    version: RUNNING_VERSION,
                }));
            }

            console.log('');
            console.log(c.dim('═'.repeat(63)));
            console.log(`  ${c.bright('Gajae Code App Server - Ready')}`);
            console.log(c.dim('═'.repeat(63)));
            console.log('');
            console.log(`${c.info('[INFO]')} Server URL:  ${c.bright('http://' + DISPLAY_HOST + ':' + port)}`);
            console.log(`${c.info('[INFO]')} App root: ${c.dim(appRoot)}`);
            console.log(`${c.tip('[TIP]')}  Run "gajae-app status" for full configuration details`);
            console.log('');

            // Start watching the projects folder for changes
            await initializeSessionsWatcher();


        });

        await closeSessionsWatcher();
        let shutdownStarted = false;
        const shutdownRuntimeServices = async () => {
            if (shutdownStarted) {
                return;
            }
            shutdownStarted = true;

            let gjcShutdownFenced = false;
            try {
                await gjcJobOrchestrator.interruptForShutdown();
                gjcShutdownFenced = true;
            } catch (err) {
                console.error('[GJC Jobs] Shutdown fence failed; forcing worker tree reap while preserving authority failure evidence:', err?.message || err);
            }

            await drainWebSocketClients(wss.clients);
            server.close();
            wss.close();
            server.closeAllConnections?.();

            try {
                await shutdownGjcWorker();
            } catch (err) {
                console.error('[GJC Worker] Worker tree reap failed during shutdown; refusing normal process exit:', err?.message || err);
                process.exitCode = 1;
                setInterval(() => {}, 60 * 60 * 1000);
                return;
            }

            try {
                await automationService.shutdown();
            } catch (err) {
                console.error('[Automation] Sidecar shutdown failed:', err?.message || err);
            }

            if (gjcShutdownFenced) {
                try {
                    gjcJobOrchestrator.close();
                } catch (err) {
                    console.error('[GJC Jobs] Error closing authority clients during shutdown:', err?.message || err);
                }
            }
            try {
                await removeLocalServerMarker();
            } catch (err) {
                console.error('[Local Server] Error removing server marker during shutdown:', err?.message || err);
            }
            process.exit(0);
        };
        process.on('SIGTERM', () => void shutdownRuntimeServices());
        process.on('SIGINT', () => void shutdownRuntimeServices());
    } catch (error) {
        console.error('[ERROR] Failed to start server:', error);
        process.exit(1);
    }
}

startServer();
