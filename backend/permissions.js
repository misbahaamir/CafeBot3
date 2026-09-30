// The single source of truth for what each staff role may do. The order store
// checks it on every staff action; the UI only uses it to hide buttons.
const PERMISSIONS = {
  MANAGER: ['orders:view', 'orders:advance', 'orders:cancel'],
  BARISTA: ['orders:view', 'orders:advance'],
};

const ROLES = Object.keys(PERMISSIONS);

function permissionsFor(role) {
  return Object.hasOwn(PERMISSIONS, role) ? PERMISSIONS[role] : [];
}

function can(role, permission) {
  return permissionsFor(role).includes(permission);
}

module.exports = { ROLES, permissionsFor, can };
