import { nowUtc } from "../domain/clock.js";
import { AccountNotFound, InvalidEntry } from "./exceptions.js";

const MAX_DEPTH = 8;

/**
 * @param {import('pg').PoolClient} client
 */
export async function listAccounts(client) {
  const result = await client.query(
    `SELECT a.code, a.name, a.type, a.is_group, a.is_active, a.prevent_overdraft, a.description,
            p.code AS parent_code
     FROM accounts a
     LEFT JOIN accounts p ON p.id = a.parent_id
     ORDER BY a.code`,
  );
  return result.rows.map(toAccount);
}

/**
 * @param {import('pg').PoolClient} client
 * @param {string} code
 */
export async function getAccount(client, code) {
  const result = await client.query(
    `SELECT a.code, a.name, a.type, a.is_group, a.is_active, a.prevent_overdraft, a.description,
            p.code AS parent_code
     FROM accounts a
     LEFT JOIN accounts p ON p.id = a.parent_id
     WHERE a.code = $1`,
    [code],
  );
  if (result.rowCount === 0) throw new AccountNotFound(code);
  return toAccount(result.rows[0]);
}

/**
 * @param {import('pg').PoolClient} client
 * @param {{
 *   code: string,
 *   name: string,
 *   type: string,
 *   parentCode: string,
 *   isGroup: boolean,
 *   preventOverdraft: boolean,
 *   description?: string | null,
 * }} input
 */
export async function createAccount(client, input) {
  const parent = await client.query(
    "SELECT id, code, type, is_group FROM accounts WHERE code = $1",
    [input.parentCode],
  );
  if (parent.rowCount === 0) throw new AccountNotFound(input.parentCode);
  const parentRow = parent.rows[0];
  if (!parentRow.is_group) {
    throw new InvalidEntry(`Parent ${input.parentCode} is not a group account.`);
  }
  if (parentRow.type !== input.type) {
    throw new InvalidEntry(`Account type ${input.type} does not match parent type ${parentRow.type}.`);
  }
  if (input.preventOverdraft && input.type !== "asset") {
    throw new InvalidEntry("Only asset accounts can prevent overdraft.");
  }
  await assertParentChain(client, parentRow.id);

  try {
    await client.query(
      `INSERT INTO accounts (
         code, name, type, parent_id, is_group, is_active, prevent_overdraft, description, created_at
       ) VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8)`,
      [
        input.code,
        input.name.trim(),
        input.type,
        parentRow.id,
        input.isGroup,
        input.preventOverdraft,
        input.description ?? null,
        nowUtc(),
      ],
    );
  } catch (error) {
    if (error?.code === "23505") throw new InvalidEntry(`Account ${input.code} already exists.`);
    throw error;
  }
  return getAccount(client, input.code);
}

/**
 * Deactivate a leaf, or a group that has no active children. History is kept.
 * @param {import('pg').PoolClient} client
 * @param {string} code
 */
export async function deactivateAccount(client, code) {
  const account = await client.query("SELECT id, is_group FROM accounts WHERE code = $1", [code]);
  if (account.rowCount === 0) throw new AccountNotFound(code);
  if (account.rows[0].is_group) {
    const children = await client.query(
      "SELECT 1 FROM accounts WHERE parent_id = $1 AND is_active = true LIMIT 1",
      [account.rows[0].id],
    );
    if (children.rowCount) throw new InvalidEntry(`Group ${code} still has active children.`);
  }
  await client.query("UPDATE accounts SET is_active = false WHERE id = $1", [account.rows[0].id]);
  return getAccount(client, code);
}

async function assertParentChain(client, parentId) {
  let current = parentId;
  const seen = new Set();
  while (current != null) {
    if (seen.has(current)) throw new InvalidEntry("Parent chain contains a cycle.");
    seen.add(current);
    const row = await client.query("SELECT parent_id FROM accounts WHERE id = $1", [current]);
    current = row.rows[0]?.parent_id ?? null;
  }
  if (seen.size + 1 > MAX_DEPTH) throw new InvalidEntry("Account depth cannot exceed 8.");
}

function toAccount(row) {
  return {
    code: row.code,
    name: row.name,
    type: row.type,
    parentCode: row.parent_code,
    isGroup: row.is_group,
    isActive: row.is_active,
    preventOverdraft: row.prevent_overdraft,
    description: row.description,
  };
}
