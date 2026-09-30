// Only permissions that some feature checks today; later features add theirs.
const PERMISSIONS = {
  ADMIN: ['properties:view', 'requests:view', 'requests:manage', 'ledger:view', 'ledger:record'],
  MANAGER: ['properties:view', 'requests:view', 'requests:manage', 'ledger:view', 'ledger:record'],
  BOOKKEEPER: ['properties:view', 'ledger:view', 'ledger:record'],
  ACCOUNTANT: ['properties:view', 'ledger:view'],
};
const ROLES = Object.keys(PERMISSIONS);

function permissionsFor(role) {
  return Object.hasOwn(PERMISSIONS, role) ? PERMISSIONS[role] : [];
}

function can(role, permission) {
  return permissionsFor(role).includes(permission);
}

module.exports = { ROLES, permissionsFor, can };
