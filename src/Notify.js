/**
 * @fileoverview Notify
 */

/**
 * @param {JsSIP} JsSIP - The JsSIP namespace
 */
(function(JsSIP) {
  
  var Notify;
  
  /**
   * @class Notify
   * @alias JsSIP.Notify
   * @param {JsSIP.Refer} session
   */
  Notify = function(session) {
    var events = [
    'succeeded',
    'failed'
    ];
  
    // Not a session, actually a REFER or SUBSCRIBE, but kept this name to avoid
    // breaking InDialogRequestSender.
    this.session = session;
    this.direction = null;
    this.request = null;
  
    this.initEvents(events);
  };
  Notify.prototype = new JsSIP.EventEmitter();
  
  
  Notify.prototype.send = function(event, state, options) {
    var request_sender, handled_event, eventHandlers, extraHeaders, request;
  
    this.direction = 'outgoing';
  
    // Check subscription state
    if (this.session.subscription_state !== 'active' &&
        this.session.subscription_state !== 'pending') {
      throw new JsSIP.Exceptions.InvalidStateError(this.session.subscription_state);
    }
  
    // Get Notify options
    options = options || {};
    extraHeaders = options.extraHeaders ? options.extraHeaders.slice() : [];
    eventHandlers = options.eventHandlers || {};
  
    // Set event handlers
    for (handled_event in eventHandlers) {
      this.on(handled_event, eventHandlers[handled_event]);
    }
  
    request = this.session.dialog.createRequest(JsSIP.C.NOTIFY, extraHeaders);
    this.request = request;
  
    request.setHeader('contact', this.session.contact);
    request.setHeader('event', event);
    request.setHeader('subscription-state', state);

    if (options.content_type) {
      request.setHeader('content-type', options.content_type);
    }
    if (options.body) {
      request.body = options.body;
    }
  
    // Don't use InDialogRequestSender, as we don't need the special 408/481
    // response handling - any error terminates the subscribe dialog.
    request_sender = new JsSIP.RequestSender(this, this.session.ua);
  
    this.session.emit('notify', this.session, {
      originator: 'local',
      notify: this,
      request: request
    });
  
    request_sender.send();
  };
  
  /**
   * @private
   */
  Notify.prototype.receiveResponse = function(response) {
    var cause;
  
    // Double-check that the session has not been terminated
    if (this.session.subscription_state === 'terminated') {
      return;
    }

    switch(true) {
      case /^1[0-9]{2}$/.test(response.status_code):
        // Ignore provisional responses.
        break;
  
      case /^2[0-9]{2}$/.test(response.status_code):
        this.emit('succeeded', this, {
          originator: 'remote',
          response: response
        });
        break;
  
      default:
        cause = JsSIP.Utils.sipErrorCause(response.status_code);
        this.emit('failed', this, {
          originator: 'remote',
          response: response,
          cause: cause
        });
        break;
    }
  };
  
  /**
   * @private
   */
  Notify.prototype.onRequestTimeout = function() {
    this.emit('failed', this, {
      originator: 'system',
      cause: JsSIP.C.causes.REQUEST_TIMEOUT
    });
  };
  
  /**
   * @private
   */
  Notify.prototype.onTransportError = function() {
    this.emit('failed', this, {
      originator: 'system',
      cause: JsSIP.C.causes.CONNECTION_ERROR
    });
  };
  
  JsSIP.Notify = Notify;
}(JsSIP));
