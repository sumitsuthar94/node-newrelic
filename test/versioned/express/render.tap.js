/*
 * Copyright 2020 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

// shut up, Express
process.env.NODE_ENV = 'test'

var test = require('tap').test
var request = require('request')
var helper = require('../../lib/agent_helper')
var API = require('../../../api')

var TEST_PATH = '/test'
var TEST_HOST = 'localhost'
var TEST_URL = 'http://' + TEST_HOST + ':'
var DELAY = 600
var BODY = "<!DOCTYPE html>\n" +
           "<html>\n" +
           "<head>\n" +
           "  <title>yo dawg</title>\n" +
           "</head>\n" +
           "<body>\n" +
           "  <p>I heard u like HTML.</p>\n" +
           "</body>\n" +
           "</html>\n"


runTests({
  license_key: 'test',
  feature_flag: {express_segments: false}
})

runTests({
  license_key: 'test',
  feature_flag: {express_segments:  true}
})

function runTests(conf) {
  // Regression test for issue 154
  // https://github.com/newrelic/node-newrelic/pull/154
  test("using only the express router", function(t) {
    var agent = helper.instrumentMockedAgent(conf)
    var router = require('express').Router() // eslint-disable-line new-cap

    t.tearDown(function cb_tearDown() {
      helper.unloadAgent(agent)
    })

    router.get('/test', function() {
      //
    })

    router.get('/test2', function() {
      //
    })

    // just try not to blow up
    t.end()
  })

  test("the express router should go through a whole request lifecycle", function(t) {
    var agent = helper.instrumentMockedAgent(conf)
    var router = require('express').Router() // eslint-disable-line new-cap
    var server

    t.plan(2)

    t.tearDown(function cb_tearDown() {
      helper.unloadAgent(agent)
    })

    router.get('/test', function(_, res) {
      t.ok(true)
      res.end()
    })

    server = require('http').createServer(router)
    server.listen(0, function() {
      var port = server.address().port
      request.get('http://localhost:' + port + '/test', function(error) {
        server.close()

        t.error(error)
        t.end()
      })
    })
  })

  test("agent instrumentation of Express", function(t) {
    t.plan(6)

    var agent = null
    var app = null
    var server = null

    t.beforeEach(function(done) {
      agent = helper.instrumentMockedAgent(conf)

      app = require('express')()
      server = require('http').createServer(app)
      done()
    })

    t.afterEach(function(done) {
      server.close()
      helper.unloadAgent(agent)

      agent = null
      app = null
      server = null

      done()
    })

    t.test("for a normal request", {timeout : 1000}, function(t) {
      // set apdexT so apdex stats will be recorded
      agent.config.apdex_t = 1

      app.get(TEST_PATH, function(req, res) {
        res.send({yep : true})
      })

      server.listen(0, TEST_HOST, function() {
        var port = server.address().port
        request.get(TEST_URL + port + TEST_PATH, function(error, response, body) {
          t.error(error, 'should not fail making request')

          t.ok(
            /application\/json/.test(response.headers['content-type']),
            "got correct content type"
          )

          t.deepEqual(JSON.parse(body), {"yep":true}, "Express correctly serves.")

          var stats

          stats = agent.metrics.getMetric('WebTransaction/Expressjs/GET//test')
          t.ok(stats, "found unscoped stats for request path")
          t.equal(stats.callCount, 1, "/test was only requested once")

          stats = agent.metrics.getOrCreateApdexMetric('Apdex/Expressjs/GET//test')
          t.ok(stats, "found apdex stats for request path")
          t.equal(stats.satisfying, 1, "got satisfactory response time")
          t.equal(stats.tolerating, 0, "got no tolerable requests")
          t.equal(stats.frustrating, 0, "got no frustrating requests")

          stats = agent.metrics.getMetric('WebTransaction')
          t.ok(stats, "found roll-up statistics for web requests")
          t.equal(stats.callCount, 1, "only one web request was made")

          stats = agent.metrics.getMetric('HttpDispatcher')
          t.ok(stats, "found HTTP dispatcher statistics")
          t.equal(stats.callCount, 1, "only one HTTP-dispatched request was made")

          var serialized = JSON.stringify(agent.metrics._toPayloadSync())
          t.ok(
            serialized.match(/WebTransaction\/Expressjs\/GET\/\/test/),
            "serialized metrics as expected"
          )

          t.end()
        })
      })
    })

    t.test("using EJS templates", {timeout : 1000}, function(t) {
      app.set('views', __dirname + '/views')
      app.set('view engine', 'ejs')

      app.get(TEST_PATH, function(req, res) {
        res.render('index', { title: 'yo dawg' })
      })

      agent.once('transactionFinished', function() {
        var stats = agent.metrics.getMetric('View/index/Rendering')
        t.equal(stats.callCount, 1, "should note the view rendering")
      })

      server.listen(0, TEST_HOST, function() {
        var port = server.address().port
        request(TEST_URL + port + TEST_PATH, function(error, response, body) {
          t.error(error, 'should not error making request')

          t.equal(response.statusCode, 200, "response code should be 200")
          t.equal(body, BODY, "template should still render fine")

          t.end()
        })
      })
    })

    t.test("should generate rum headers", {timeout : 1000}, function(t) {
      var api = new API(agent)

      agent.config.application_id = '12345'
      agent.config.browser_monitoring.browser_key = '12345'
      agent.config.browser_monitoring.js_agent_loader = 'function() {}'

      app.set('views', __dirname + '/views')
      app.set('view engine', 'ejs')

      app.get(TEST_PATH, function(req, res) {
        var rum = api.getBrowserTimingHeader()
        t.equal(rum.substr(0,7), '<script')
        res.render('index', { title: 'yo dawg', rum: rum })
      })

      agent.once('transactionFinished', function() {
        var stats = agent.metrics.getMetric('View/index/Rendering')
        t.equal(stats.callCount, 1, "should note the view rendering")
      })

      server.listen(0, TEST_HOST, function() {
        var port = server.address().port
        request(TEST_URL + port + TEST_PATH, function(error, response, body) {
          t.error(error, 'should not error making request')

          t.equal(response.statusCode, 200, "response code should be 200")
          t.equal(body, BODY, "template should still render fine")

          t.end()
        })
      })
    })

    t.test("should trap errors correctly", function(t) {
      app.get(TEST_PATH, function() {
        var hmm
        hmm.ohno.failure.is.terrible()
      })

      server.listen(0, TEST_HOST, function() {
        for (var i = 0; i < app._router.stack.length; i++) {
          var layer = app._router.stack[i]
          // route middleware doesn't have a name, sentinel is our error handler,
          // neither should be wrapped.
          if (layer.route === undefined && layer.handle.name !== 'sentinel') {
            t.equal(
              typeof layer.handle.__NR_original,
              'function',
              'all middlewares are wrapped'
            )
          }
        }

        var port = server.address().port
        request.get(TEST_URL + port + TEST_PATH, function(error, response, body) {
          t.error(error, 'should not error making request')

          t.ok(response, "got a response from Express")
          t.ok(body, "got back a body")

          var errors = agent.errors.traceAggregator.errors
          t.ok(errors, "errors were found")
          t.equal(errors.length, 1, "Only one error thrown.")

          var first = errors[0]
          t.ok(first, "have the first error")

          t.equal(
            first[2],
            "Cannot read property 'ohno' of undefined",
            "got the expected error"
          )

          t.end()
        })
      })
    })

    t.test('measure request duration properly (NA-46)', {timeout: 2000}, function(t) {
      app.get(TEST_PATH, function(req, res) {
        t.ok(agent.getTransaction(), 'should have transaction inside middleware')
        setTimeout(function() { res.send(BODY) }, DELAY)
      })

      server.listen(0, TEST_HOST, function ready() {
        var port = server.address().port
        request.get(TEST_URL + port + TEST_PATH, function(error, response, body) {
          t.error(error, 'should not fail making request')

          var isFramework = agent.environment.get('Framework').indexOf('Expressjs') > -1
          t.ok(isFramework, 'should indicate that express is a framework')

          t.notOk(agent.getTransaction(), "transaction shouldn't be visible from request")
          t.equals(body, BODY, "response and original page text match")

          var stats = agent.metrics.getMetric('WebTransaction/Expressjs/GET//test')
          t.ok(stats, "Statistics should have been found for request.")

          var timing = stats.total * 1000
          t.ok(timing > DELAY - 50, 'should have expected timing (within reason)')

          t.end()
        })
      })
    })

    t.test("should capture URL correctly with a prefix", {timeout : 2000}, function(t) {
      app.use(TEST_PATH, function(req, res) {
        t.ok(agent.getTransaction(), 'should maintain transaction state in middleware')
        t.equal(req.url, '/ham', 'should have correct test url')
        res.send(BODY)
      })

      server.listen(0, TEST_HOST, function ready() {
        var port = server.address().port
        var url = TEST_URL + port + TEST_PATH + '/ham'
        request.get(url, function(error, response, body) {
          t.error(error, 'should not fail making request')

          t.notOk(agent.getTransaction(), "transaction shouldn't be visible from request")
          t.equals(body, BODY, "response and original page text match")

          var stats = agent.metrics.getMetric('WebTransaction/Expressjs/GET//test')
          t.ok(stats, "Statistics should have been found for request.")

          t.end()
        })
      })
    })
  })

  test("trapping errors", function(t) {
    t.autoend()

    t.test('collects the actual error object that is thrown', function(t) {
      const agent = helper.instrumentMockedAgent(conf)

      var app    = require('express')()
      var server = require('http').createServer(app)

      t.tearDown(function cb_tearDown() {
        server.close()
        helper.unloadAgent(agent)
      })

      app.get(TEST_PATH, function() {
        throw new Error('some error')
      })

      server.listen(0, TEST_HOST, function() {
        var port = server.address().port
        request.get(TEST_URL + port + TEST_PATH, function() {
          var errors = agent.errors.traceAggregator.errors
          t.equal(errors.length, 1, "there should be one error")
          t.equal(errors[0][2], "some error", "got the expected error")
          t.ok(errors[0][4].stack_trace, "has stack trace")

          var metric = agent.metrics.getMetric('Apdex')
          t.ok(metric.frustrating === 1, 'apdex should be frustrating')

          t.end()
        })
      })
    })

    t.test('does not occur with custom defined error handlers', function(t) {
      const agent = helper.instrumentMockedAgent(conf)

      var app    = require('express')()
      var server = require('http').createServer(app)

      t.tearDown(function cb_tearDown() {
        server.close()
        helper.unloadAgent(agent)
      })
      var error = new Error('some error')

      app.get(TEST_PATH, function() {
        throw error
      })

      app.use(function(err, req, res, next) {
        t.equal(err, error, 'should see the same error in the error handler')
        next()
      })

      server.listen(0, TEST_HOST, function() {
        var port = server.address().port
        request.get(TEST_URL + port + TEST_PATH, function() {
          var errors = agent.errors.traceAggregator.errors
          t.equal(errors.length, 0, "there should be no errors")

          var metric = agent.metrics.getMetric('Apdex')
          t.ok(metric.frustrating === 0, 'apdex should not be frustrating')

          t.end()
        })
      })
    })

    t.test('does not occur with custom defined error handlers', function(t) {
      const agent = helper.instrumentMockedAgent(conf)

      var app    = require('express')()
      var server = require('http').createServer(app)

      t.tearDown(function cb_tearDown() {
        server.close()
        helper.unloadAgent(agent)
      })
      var error = new Error('some error')

      app.get(TEST_PATH, function(req, res, next) {
        next(error)
      })

      app.use(function(err, req, res, next) {
        t.equal(err, error, 'should see the same error in the error handler')
        next()
      })

      server.listen(0, TEST_HOST, function() {
        var port = server.address().port
        request.get(TEST_URL + port + TEST_PATH, function() {
          var errors = agent.errors.traceAggregator.errors
          t.equal(errors.length, 0, "there should be no errors")

          var metric = agent.metrics.getMetric('Apdex')
          t.ok(metric.frustrating === 0, 'apdex should not be frustrating')

          t.end()
        })
      })
    })

    t.test('collects the error message when string is thrown', function(t) {
      const agent = helper.instrumentMockedAgent(conf)

      var app    = require('express')()
      var server = require('http').createServer(app)

      t.tearDown(function cb_tearDown() {
        server.close()
        helper.unloadAgent(agent)
      })

      app.get(TEST_PATH, function() {
        throw 'some error'
      })

      server.listen(0, TEST_HOST, function() {
        var port = server.address().port
        request.get(TEST_URL + port + TEST_PATH, function() {
          var errors = agent.errors.traceAggregator.errors
          t.equal(errors.length, 1, "there should be one error")
          t.equal(errors[0][2], "some error", "got the expected error")

          var metric = agent.metrics.getMetric('Apdex')
          t.ok(metric.frustrating === 1, 'apdex should be frustrating')

          t.end()
        })
      })
    })

    t.test('collects the actual error object when error handler is used', function(t) {
      const agent = helper.instrumentMockedAgent(conf)

      var app    = require('express')()
      var server = require('http').createServer(app)

      t.tearDown(function cb_tearDown() {
        server.close()
        helper.unloadAgent(agent)
      })

      app.get(TEST_PATH, function() {
        throw new Error('some error')
      })

      app.use(function(err, rer, res, next) { // eslint-disable-line no-unused-vars
        res.status(400).end()
      })

      server.listen(0, TEST_HOST, function() {
        var port = server.address().port
        request.get(TEST_URL + port + TEST_PATH, function() {
          var errors = agent.errors.traceAggregator.errors
          t.equal(errors.length, 1, "there should be one error")
          t.equal(errors[0][2], "some error", "got the expected error")
          t.ok(errors[0][4].stack_trace, "has stack trace")

          var metric = agent.metrics.getMetric('Apdex')
          t.ok(metric.frustrating === 1, 'apdex should be frustrating')

          t.end()
        })
      })
    })

    // Some error handlers might sanitize the error object, removing stack and/or message
    // properties, so that it can be serialized and sent back in the response body.
    // We use message and stack properties to identify an Error object, so in this case
    // we want to at least collect the HTTP error based on the status code.
    t.test('should report errors without message or stack sent to res.send', function(t) {
      const agent = helper.instrumentMockedAgent(conf)

      var app    = require('express')()
      var server = require('http').createServer(app)

      t.tearDown(function cb_tearDown() {
        server.close()
        helper.unloadAgent(agent)
      })

      var error = new Error('some error')
      app.get(TEST_PATH, function() {
        throw error
      })

      app.use(function(err, rer, res, next) { // eslint-disable-line no-unused-vars
        delete err.message
        delete err.stack
        res.status(400).send(err)
      })

      server.listen(0, TEST_HOST, function() {
        var port = server.address().port
        request.get(TEST_URL + port + TEST_PATH, function() {
          var errors = agent.errors.traceAggregator.errors
          t.equal(errors.length, 1, "there should be one error")
          t.equal(errors[0][2], "HttpError 400", "got the expected error")

          var metric = agent.metrics.getMetric('Apdex')
          t.ok(metric.frustrating === 1, 'apdex should be frustrating')

          t.end()
        })
      })
    })

    t.test('should report errors without message or stack sent to next', function(t) {
      const agent = helper.instrumentMockedAgent(conf)

      var app    = require('express')()
      var server = require('http').createServer(app)

      t.tearDown(function cb_tearDown() {
        server.close()
        helper.unloadAgent(agent)
      })

      var error = new Error('some error')
      app.get(TEST_PATH, function() {
        throw error
      })

      app.use(function errorHandler(err, rer, res, next) {
        delete err.message
        delete err.stack
        next(err)
      })

      server.listen(0, TEST_HOST, function() {
        var port = server.address().port
        request.get(TEST_URL + port + TEST_PATH, function() {
          var errors = agent.errors.traceAggregator.errors
          t.equal(errors.length, 1, "there should be one error")
          t.equal(errors[0][2], "HttpError 500", "got the expected error")

          var metric = agent.metrics.getMetric('Apdex')
          t.ok(metric.frustrating === 1, 'apdex should be frustrating')

          t.end()
        })
      })
    })
  })

  test('layer wrapping', function(t) {
    t.plan(1)

    // Set up the test.
    var agent = helper.instrumentMockedAgent(conf)
    var app = require('express')()
    var server = require('http').createServer(app)
    t.tearDown(function cb_tearDown() {
      server.close()
      helper.unloadAgent(agent)
    })

    // Add our route.
    app.get(TEST_PATH, function(req, res) {
      res.send('bar')
    })

    // Proxy the last layer on the stack.
    var stack = app._router.stack
    stack[stack.length - 1] = makeProxyLayer(stack[stack.length - 1])

    // Make our request.
    server.listen(0, TEST_HOST, function() {
      var port = server.address().port
      request.get(TEST_URL + port + TEST_PATH, function(err, response, body) {
        t.equals(body, 'bar', 'should not fail with a proxy layer')
        t.end()
      })
    })
  })
}

/**
 * Wraps a layer in a proxy with all of the layer's prototype's methods directly
 * on itself.
 *
 * @param {express.Layer} layer - The layer to proxy.
 *
 * @return {object} A POD object with all the fields of the layer copied over.
 */
function makeProxyLayer(layer) {
  var fakeLayer = {
    handle_request: function() { layer.handle_request.apply(layer, arguments) },
    handle_error: function() { layer.handle_error.apply(layer, arguments) }
  }
  Object.keys(layer).forEach(function(k) {
    if (!fakeLayer[k]) {
      fakeLayer[k] = layer[k]
    }
  })
  Object.keys(layer.constructor.prototype).forEach(function(k) {
    if (!fakeLayer[k]) {
      fakeLayer[k] = layer[k]
    }
  })
  return fakeLayer
}
