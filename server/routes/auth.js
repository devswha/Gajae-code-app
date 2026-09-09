import express from 'express';

import { authenticateToken } from '../middleware/auth.js';
import { isDesktopMode } from '../middleware/desktop-auth.js';
import { asyncHandler } from '../shared/utils.js';

const router = express.Router();

router.get('/user', authenticateToken, asyncHandler((req, res) => {
  res.json({
    user: req.user,
    // The desktop webview is a loopback origin with no Tauri IPC; the client
    // needs to know it is inside the shell to route external links through
    // the sidecar instead of window.open.
    shell: { desktop: isDesktopMode() },
  });
}));

export default router;
