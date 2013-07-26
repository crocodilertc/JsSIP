/**
 * @fileoverview Exceptions
 */

/**
 * JsSIP Exceptions.
 * @augments JsSIP
 */
(function(JsSIP) {
var Exceptions;

Exceptions= {
  ConfigurationError: (function(){
    var exception = function(parameter, value) {
      this.code = 1;
      this.name = 'CONFIGURATION_ERROR';
      this.parameter = parameter;
      this.value = value;
      this.message = (!this.value)? 'Missing parameter: '+ this.parameter : 'Invalid value '+ window.JSON.stringify(this.value) +' for parameter "'+ this.parameter +'"';
    };
    exception.prototype = new Error();
    return exception;
  }()),

  InvalidTargetError: (function(){
    var exception = function(target) {
      this.code = 2;
      this.name = 'INVALID_TARGET_ERROR';
      this.target = target;
      this.message = 'Invalid target: ' + this.target;
    };
    exception.prototype = new Error();
    return exception;
  }()),

  InvalidStateError: (function(){
    var exception = function(status) {
      this.code = 3;
      this.name = 'INVALID_STATE_ERROR';
      this.status = status;
    };
    exception.prototype = new Error();
    return exception;
  }()),

  RemoteSupportError: (function(){
    var exception = function(option) {
      this.code = 4;
      this.name = 'REMOTE_SUPPORT_ERROR';
      this.option = option;
      this.message = 'Remote UA does not support method/extension: ' + option;
    };
    exception.prototype = new Error();
    return exception;
  }())
};

JsSIP.Exceptions = Exceptions;
}(JsSIP));