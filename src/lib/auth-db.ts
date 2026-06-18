import { sql } from "@vercel/postgres"
import bcrypt from "bcryptjs"

export interface AuthUser {
  id: number
  username: string
  password_hash: string
  is_active: boolean
  created_at: string
}

export interface AuthGroup {
  id: number
  name: string
  description: string
  permissions?: string[]
}

const ALL_PERMISSIONS = [
  "vbn:check",
  "vbn:fix",
  "products:create",
  "photos:upload",
  "admin:manage",
]

const DEFAULT_GROUPS: Record<string, string[]> = {
  admin: ALL_PERMISSIONS,
  operator: ["vbn:check", "vbn:fix", "products:create", "photos:upload"],
  viewer: ["vbn:check"],
}

export async function ensureAuthTables() {
  await sql`
    CREATE TABLE IF NOT EXISTS auth_users (
      id            SERIAL PRIMARY KEY,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_active     BOOLEAN DEFAULT TRUE,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `
  await sql`ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS failed_attempts INT DEFAULT 0`
  await sql`ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ`
  await sql`
    CREATE TABLE IF NOT EXISTS auth_groups (
      id          SERIAL PRIMARY KEY,
      name        TEXT UNIQUE NOT NULL,
      description TEXT DEFAULT ''
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS auth_permissions (
      id   SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS auth_user_groups (
      user_id  INT REFERENCES auth_users(id)  ON DELETE CASCADE,
      group_id INT REFERENCES auth_groups(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, group_id)
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS auth_group_permissions (
      group_id      INT REFERENCES auth_groups(id)      ON DELETE CASCADE,
      permission_id INT REFERENCES auth_permissions(id) ON DELETE CASCADE,
      PRIMARY KEY (group_id, permission_id)
    )
  `

  // Seed permissions
  for (const perm of ALL_PERMISSIONS) {
    await sql`INSERT INTO auth_permissions (name) VALUES (${perm}) ON CONFLICT (name) DO NOTHING`
  }

  // Seed default groups
  for (const [groupName, groupPerms] of Object.entries(DEFAULT_GROUPS)) {
    await sql`INSERT INTO auth_groups (name) VALUES (${groupName}) ON CONFLICT (name) DO NOTHING`
    const { rows: [group] } = await sql`SELECT id FROM auth_groups WHERE name = ${groupName}`
    if (group) {
      for (const perm of groupPerms) {
        await sql`
          INSERT INTO auth_group_permissions (group_id, permission_id)
          SELECT ${group.id}, id FROM auth_permissions WHERE name = ${perm}
          ON CONFLICT DO NOTHING
        `
      }
    }
  }

  // Seed default admin user if no users exist
  const { rows: [{ count }] } = await sql`SELECT COUNT(*)::int AS count FROM auth_users`
  if (count === 0) {
    const defaultPw = process.env.ADMIN_DEFAULT_PASSWORD ?? "admin"
    const hash = await bcrypt.hash(defaultPw, 12)
    const { rows: [newUser] } = await sql`
      INSERT INTO auth_users (username, password_hash) VALUES ('admin', ${hash}) RETURNING id
    `
    const { rows: [adminGroup] } = await sql`SELECT id FROM auth_groups WHERE name = 'admin'`
    if (newUser && adminGroup) {
      await sql`
        INSERT INTO auth_user_groups (user_id, group_id) VALUES (${newUser.id}, ${adminGroup.id})
        ON CONFLICT DO NOTHING
      `
    }
  }
}

export async function getUserByUsername(username: string): Promise<(AuthUser & { permissions: string[] }) | null> {
  try {
    await ensureAuthTables()
    const { rows } = await sql`
      SELECT id, username, password_hash, is_active, created_at
      FROM auth_users WHERE username = ${username}
    `
    if (!rows[0]) return null
    const user = rows[0] as AuthUser
    const perms = await getUserPermissions(user.id)
    return { ...user, permissions: perms }
  } catch {
    return null
  }
}

export async function getUserPermissions(userId: number): Promise<string[]> {
  const { rows } = await sql`
    SELECT DISTINCT p.name
    FROM auth_user_groups ug
    JOIN auth_group_permissions gp ON gp.group_id = ug.group_id
    JOIN auth_permissions p ON p.id = gp.permission_id
    WHERE ug.user_id = ${userId}
  `
  return rows.map((r) => r.name as string)
}

export async function isAccountLocked(username: string): Promise<boolean> {
  const { rows: [row] } = await sql`
    SELECT locked_until FROM auth_users WHERE username = ${username}
  `
  if (!row?.locked_until) return false
  return new Date(row.locked_until) > new Date()
}

export async function recordFailedLogin(username: string): Promise<void> {
  await sql`
    UPDATE auth_users
    SET
      failed_attempts = failed_attempts + 1,
      locked_until = CASE
        WHEN failed_attempts + 1 >= 5 THEN NOW() + INTERVAL '15 minutes'
        ELSE locked_until
      END
    WHERE username = ${username}
  `
}

export async function clearFailedAttempts(username: string): Promise<void> {
  await sql`
    UPDATE auth_users SET failed_attempts = 0, locked_until = NULL WHERE username = ${username}
  `
}

export async function unlockUser(userId: number): Promise<void> {
  await sql`UPDATE auth_users SET failed_attempts = 0, locked_until = NULL WHERE id = ${userId}`
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash)
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12)
}

// ── Admin CRUD ──────────────────────────────────────────────────────────────

export async function listUsers() {
  await ensureAuthTables()
  const { rows } = await sql`
    SELECT u.id, u.username, u.is_active, u.created_at,
           u.failed_attempts, u.locked_until,
           COALESCE(json_agg(g.name) FILTER (WHERE g.name IS NOT NULL), '[]') AS groups
    FROM auth_users u
    LEFT JOIN auth_user_groups ug ON ug.user_id = u.id
    LEFT JOIN auth_groups g ON g.id = ug.group_id
    GROUP BY u.id ORDER BY u.id
  `
  return rows
}

export async function createUser(username: string, password: string, groupIds: number[]) {
  await ensureAuthTables()
  const hash = await hashPassword(password)
  const { rows: [user] } = await sql`
    INSERT INTO auth_users (username, password_hash) VALUES (${username}, ${hash}) RETURNING id
  `
  for (const gid of groupIds) {
    await sql`
      INSERT INTO auth_user_groups (user_id, group_id) VALUES (${user.id}, ${gid})
      ON CONFLICT DO NOTHING
    `
  }
  return user
}

export async function updateUserPassword(userId: number, password: string) {
  const hash = await hashPassword(password)
  await sql`
    UPDATE auth_users SET password_hash = ${hash}, failed_attempts = 0, locked_until = NULL WHERE id = ${userId}
  `
}

export async function toggleUserActive(userId: number, isActive: boolean) {
  await sql`UPDATE auth_users SET is_active = ${isActive} WHERE id = ${userId}`
}

export async function deleteUser(userId: number) {
  await sql`DELETE FROM auth_users WHERE id = ${userId}`
}

export async function setUserGroups(userId: number, groupIds: number[]) {
  await sql`DELETE FROM auth_user_groups WHERE user_id = ${userId}`
  for (const gid of groupIds) {
    await sql`
      INSERT INTO auth_user_groups (user_id, group_id) VALUES (${userId}, ${gid})
      ON CONFLICT DO NOTHING
    `
  }
}

export async function listGroups(): Promise<AuthGroup[]> {
  await ensureAuthTables()
  const { rows } = await sql`
    SELECT g.id, g.name, g.description,
           COALESCE(json_agg(p.name) FILTER (WHERE p.name IS NOT NULL), '[]') AS permissions
    FROM auth_groups g
    LEFT JOIN auth_group_permissions gp ON gp.group_id = g.id
    LEFT JOIN auth_permissions p ON p.id = gp.permission_id
    GROUP BY g.id ORDER BY g.id
  `
  return rows as AuthGroup[]
}

export async function createGroup(name: string, description: string, permissionNames: string[]): Promise<AuthGroup> {
  const { rows: [group] } = await sql`
    INSERT INTO auth_groups (name, description) VALUES (${name}, ${description}) RETURNING id, name, description
  `
  for (const perm of permissionNames) {
    await sql`
      INSERT INTO auth_group_permissions (group_id, permission_id)
      SELECT ${group.id}, id FROM auth_permissions WHERE name = ${perm}
      ON CONFLICT DO NOTHING
    `
  }
  return group as AuthGroup
}

export async function updateGroup(groupId: number, description: string, permissionNames: string[]): Promise<void> {
  await sql`UPDATE auth_groups SET description = ${description} WHERE id = ${groupId}`
  await sql`DELETE FROM auth_group_permissions WHERE group_id = ${groupId}`
  for (const perm of permissionNames) {
    await sql`
      INSERT INTO auth_group_permissions (group_id, permission_id)
      SELECT ${groupId}, id FROM auth_permissions WHERE name = ${perm}
      ON CONFLICT DO NOTHING
    `
  }
}

export async function deleteGroup(groupId: number): Promise<void> {
  await sql`DELETE FROM auth_groups WHERE id = ${groupId}`
}
