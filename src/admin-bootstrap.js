import bcrypt from 'bcryptjs';
import { User } from './models/index.js';
import { usernameProblem } from './lib/play.js';

/*
 * Makes the site owner an admin. Set ADMIN_EMAIL (and, for a brand-new account, ADMIN_PASSWORD) in the
 * server's environment, e.g. in Render's dashboard. Passwords never live in the code or the repository.
 *
 *  - No account with that email yet: one is created with ADMIN_PASSWORD, as an admin.
 *  - The account already exists: it is made an admin. Its password is left alone, unless
 *    ADMIN_RESET_PASSWORD=true, which sets it to ADMIN_PASSWORD once (remove the flag afterwards).
 */
export async function ensureAdmin(env = process.env) {
  const emails = (env.ADMIN_EMAIL ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const email of emails) {
    let user = await User.findOne({ email });
    if (!user) {
      const pw = env.ADMIN_PASSWORD;
      if (!pw || pw.length < 8) {
        console.warn(`[admin] ${email} has no account yet. Set ADMIN_PASSWORD (8+ characters) to create it, or register it in the app.`);
        continue;
      }
      const base = email
        .split('@')[0]
        .replace(/[^A-Za-z0-9_-]/g, '')
        .slice(0, 20);
      const username = !usernameProblem(base) && !(await User.exists({ usernameKey: base.toLowerCase() })) ? base : undefined;
      user = await User.create({
        email,
        name: '',
        passwordHash: await bcrypt.hash(pw, 12),
        role: 'admin',
        ...(username ? { username, usernameKey: username.toLowerCase() } : {}),
      });
      console.log(`[admin] created admin account ${email}`);
      continue;
    }
    let changed = false;
    if (user.role !== 'admin') {
      user.role = 'admin';
      changed = true;
    }
    if (user.suspended) {
      user.suspended = false;
      changed = true;
    }
    if (env.ADMIN_RESET_PASSWORD === 'true' && env.ADMIN_PASSWORD?.length >= 8 && !(await bcrypt.compare(env.ADMIN_PASSWORD, user.passwordHash))) {
      user.passwordHash = await bcrypt.hash(env.ADMIN_PASSWORD, 12);
      user.tokenVersion += 1;
      changed = true;
      console.log(`[admin] password reset for ${email}; remove ADMIN_RESET_PASSWORD now`);
    }
    if (changed) {
      await user.save();
      console.log(`[admin] ${email} is an admin`);
    }
  }
}
