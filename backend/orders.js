const fs = require('fs');
const { ORDER_STATUS_FLOW } = require('./validation');
const { can } = require('./permissions');

const CANCELLED = 'CANCELLED';
const FINAL_STATUSES = ['COMPLETED', CANCELLED];

function createOrderStore(ordersPath, auditLog) {
  function readAll() {
    return JSON.parse(fs.readFileSync(ordersPath, 'utf-8'));
  }

  // JSON files have no transactions: if the audit entry can't be written, the
  // previous file contents are put back so no order change is left unlogged.
  function commit(orders, auditEntry) {
    const previous = fs.readFileSync(ordersPath, 'utf-8');
    fs.writeFileSync(ordersPath, JSON.stringify(orders, null, 2));
    try {
      auditLog.append(auditEntry);
    } catch (err) {
      fs.writeFileSync(ordersPath, previous);
      throw err;
    }
  }

  function create(order, sessionId) {
    const orders = readAll();
    orders.push(order);
    commit(orders, {
      actorType: 'CUSTOMER',
      actorId: sessionId,
      action: 'CREATE',
      entityType: 'ORDER',
      entityId: order.id,
      before: null,
      after: order,
      reason: null,
    });
    return order;
  }

  function list(staff) {
    if (!can(staff.role, 'orders:view')) {
      return { error: 'forbidden' };
    }
    return { orders: readAll() };
  }

  function updateStatus(id, status, staff) {
    if (!can(staff.role, 'orders:advance')) {
      return { error: 'forbidden' };
    }
    const orders = readAll();
    const order = orders.find((o) => o.id === id);
    if (!order) {
      return { error: 'order_not_found' };
    }

    if (FINAL_STATUSES.includes(order.status)) {
      return { error: 'invalid_transition' };
    }

    const currentIndex = ORDER_STATUS_FLOW.indexOf(order.status);
    const nextIndex = ORDER_STATUS_FLOW.indexOf(status);
    if (nextIndex !== currentIndex + 1) {
      return { error: 'invalid_transition' };
    }

    const previousStatus = order.status;
    order.status = status;
    commit(orders, {
      actorType: 'STAFF',
      actorId: staff.username,
      action: 'STATUS_CHANGE',
      entityType: 'ORDER',
      entityId: id,
      before: { status: previousStatus },
      after: { status },
      reason: null,
    });
    return { order };
  }

  // Orders are never deleted; cancelling keeps the record with its reason.
  function cancel(id, reason, staff) {
    if (!can(staff.role, 'orders:cancel')) {
      return { error: 'forbidden' };
    }
    const orders = readAll();
    const order = orders.find((o) => o.id === id);
    if (!order) {
      return { error: 'order_not_found' };
    }
    if (FINAL_STATUSES.includes(order.status)) {
      return { error: 'invalid_transition' };
    }

    const previousStatus = order.status;
    order.status = CANCELLED;
    order.cancelledAt = new Date().toISOString();
    order.cancelReason = reason;
    commit(orders, {
      actorType: 'STAFF',
      actorId: staff.username,
      action: 'CANCEL',
      entityType: 'ORDER',
      entityId: id,
      before: { status: previousStatus },
      after: { status: CANCELLED },
      reason,
    });
    return { order };
  }

  function history(id, staff) {
    if (!can(staff.role, 'orders:view')) {
      return { error: 'forbidden' };
    }
    if (!readAll().some((o) => o.id === id)) {
      return { error: 'order_not_found' };
    }
    const entries = auditLog.readAll().filter((e) => e.entityType === 'ORDER' && e.entityId === id);
    return { entries: entries.reverse() };
  }

  return { list, create, updateStatus, cancel, history };
}

module.exports = { createOrderStore };
