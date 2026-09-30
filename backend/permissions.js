// Only permissions that some feature checks today; later features add theirs.
const PERMISSIONS = {
  ADMIN: ['properties:view'],
  MANAGER: ['properties:view'],
  BOOKKEEPER: ['properties:view'],
  ACCOUNTANT: ['properties:view'],
};
const ROLES = Object.keys(PERMISSIONS);

function permissionsFor(role) {
  return Object.hasOwn(PERMISSIONS, role) ? PERMISSIONS[role] : [];
}

function can(role, permission) {
  return permissionsFor(role).includes(permission);
}

module.exports = { ROLES, permissionsFor, can };
