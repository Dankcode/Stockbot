export function createInAppChannel(eventHub) {
  return {
    async send({ alert, delivery, event }) {
      eventHub.publish("alert", { alertId: alert.id, deliveryId: delivery.id, name: alert.name, event });
    }
  };
}
