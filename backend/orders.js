const fs = require('fs');
const { ORDER_STATUS_FLOW } = require('./validation');

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

  function updateStatus(id, status) {
    const orders = readAll();
    const order = orders.find((o) => o.id === id);
    if (!order) {
      return { error: 'order_not_found' };
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
      actorId: null,
      action: 'STATUS_CHANGE',
      entityType: 'ORDER',
      entityId: id,
      before: { status: previousStatus },
      after: { status },
      reason: null,
    });
    return { order };
  }

  return { readAll, create, updateStatus };
}

module.exports = { createOrderStore };
