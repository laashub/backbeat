const assert = require('assert');
const async = require('async');
const http = require('http');
const Redis = require('ioredis');
const { Producer } = require('node-rdkafka');

const { RedisClient } = require('arsenal').metrics;

const StatsModel = require('../../../lib/models/StatsModel');
const config = require('../../config.json');
const { makePOSTRequest, getResponseBody } =
    require('../utils/makePOSTRequest');
const S3Mock = require('../utils/S3Mock');
const VaultMock = require('../utils/VaultMock');
const redisConfig = { host: '127.0.0.1', port: 6379 };
const TEST_REDIS_KEY_FAILED_CRR = 'test:bb:crr:failed';

const fakeLogger = {
    trace: () => {},
    error: () => {},
    info: () => {},
    debug: () => {},
};

const defaultOptions = {
    host: config.server.host,
    port: config.server.port,
    method: 'GET',
};

function getUrl(options, path) {
    return `http://${options.host}:${options.port}${path}`;
}

function setKey(redisClient, keys, cb) {
    const cmds = keys.map(key => {
        const value = 'arn:aws:iam::604563867484:test-role';
        return ['set', `${TEST_REDIS_KEY_FAILED_CRR}:${key}`, value];
    });
    redisClient.batch(cmds, cb);
}

function setDummyKey(redisClient, keys, cb) {
    const cmds = keys.map(key => ['set', key, 'null']);
    redisClient.batch(cmds, cb);
}

function deleteKeys(redisClient, cb) {
    redisClient.batch([['flushall']], cb);
}

function makeRetryPOSTRequest(body, cb) {
    const options = Object.assign({}, defaultOptions, {
        method: 'POST',
        path: '/_/crr/failed',
    });
    makePOSTRequest(options, body, cb);
}

function getRequest(path, done) {
    const params = {
        host: '127.0.0.1',
        port: 8900,
        method: 'GET',
        path,
    };
    // eslint-disable-next-line
    const req = http.request(params, res => {
        if (res.statusCode !== 200) {
            return done(res);
        }

        const chunks = [];
        res.on('data', chunk => {
            chunks.push(chunk);
        });
        res.on('end', () => {
            let body;
            try {
                body = JSON.parse(Buffer.concat(chunks).toString());
            } catch (e) {
                return done(e);
            }
            return done(null, body);
        });
    });
    req.on('error', err => done(err));
    req.end();
}

describe('Backbeat Server', () => {
    it('should get a 404 route not found error response', () => {
        const url = getUrl(defaultOptions, '/_/invalidpath');

        http.get(url, res => {
            assert.equal(res.statusCode, 404);
        });
    });

    it('should get a 405 method not allowed from invalid http verb', done => {
        const options = Object.assign({}, defaultOptions);
        options.method = 'DELETE';
        options.path = '/_/healthcheck';

        const req = http.request(options, res => {
            assert.equal(res.statusCode, 405);
        });
        req.on('error', err => {
            assert.ifError(err);
        });
        req.end();
        done();
    });

    describe('healthcheck route', () => {
        let data;
        let healthcheckTimer;
        let resCode;
        let testProducer;

        function _doHealthcheckRequest(done) {
            const url = getUrl(defaultOptions, '/_/healthcheck');

            http.get(url, res => {
                resCode = res.statusCode;

                let rawData = '';
                res.on('data', chunk => {
                    rawData += chunk;
                });
                res.on('end', () => {
                    data = JSON.parse(rawData);
                    if (done) {
                        // only set in before() processing
                        done();
                    }
                });
            });
        }

        before(done => {
            async.series([
                next => {
                    testProducer = new Producer({
                        'metadata.broker.list': config.kafka.hosts,
                    });
                    testProducer.connect();
                    testProducer.on('ready', () => next());
                    testProducer.on('event.error', error => {
                        assert.ifError(error);
                    });
                },
                // create topics by fetching metadata from these topics
                // (works if auto.create.topics.enabled is true)
                next => testProducer.getMetadata({
                    topic: config.extensions.replication.topic,
                    timeout: 10000,
                }, next),
                next => testProducer.getMetadata({
                    topic: config.extensions.replication.replicationStatusTopic,
                    timeout: 10000,
                }, next),
                next => {
                    _doHealthcheckRequest(next);
                    // refresh healthcheck result, as after creating
                    // topics they take some time to appear in the
                    // healthcheck results
                    healthcheckTimer = setInterval(_doHealthcheckRequest,
                                                   2000);
                },
            ], done);
        });

        after(() => {
            clearInterval(healthcheckTimer);
        });

        it('should get a response with data', done => {
            assert.equal(resCode, 200);
            assert(data);
            return done();
        });

        it('should have valid keys', done => {
            assert(data.topics);
            let timer = undefined;
            function _checkValidKeys() {
                const repTopic =
                          data.topics[config.extensions.replication.topic];
                if (!repTopic) {
                    return undefined;
                }
                clearInterval(timer);
                assert(Array.isArray(repTopic.partitions));
                assert(data.internalConnections);
                // NOTE: isrHealth is not checked here because circleci
                // kafka will have one ISR only. Maybe isrHealth should
                // be a test for end-to-end
                assert.strictEqual(
                    data.internalConnections.zookeeper.status, 'ok');
                assert.strictEqual(
                    data.internalConnections.kafkaProducer.status, 'ok');
                return done();
            }
            timer = setInterval(_checkValidKeys, 1000);
        }).timeout(20000);
    });

    describe('API routes', function dF() {
        this.timeout(10000);
        const interval = 300;
        const expiry = 900;
        const OPS = 'test:bb:ops';
        const BYTES = 'test:bb:bytes';
        const OPS_DONE = 'test:bb:opsdone';
        const OPS_FAIL = 'test:bb:opsfail';
        const BYTES_DONE = 'test:bb:bytesdone';
        const BYTES_FAIL = 'test:bb:bytesfail';

        const destconfig = config.extensions.replication.destination;
        const site1 = destconfig.bootstrapList[0].site;
        const site2 = destconfig.bootstrapList[1].site;

        let redisClient;
        let statsClient;
        let redis;

        before(done => {
            redis = new Redis();
            redisClient = new RedisClient(redisConfig, fakeLogger);
            statsClient = new StatsModel(redisClient, interval, expiry);
            const s3Mock = new S3Mock();
            const vaultMock = new VaultMock();
            http.createServer((req, res) => s3Mock.onRequest(req, res))
                .listen(config.extensions.replication.source.s3.port);
            http.createServer((req, res) => vaultMock.onRequest(req, res))
                .listen(config.extensions.replication.source.auth.vault.port);

            statsClient.reportNewRequest(`${site1}:${OPS}`, 1725);
            statsClient.reportNewRequest(`${site1}:${BYTES}`, 2198);
            statsClient.reportNewRequest(`${site1}:${OPS_DONE}`, 450);
            statsClient.reportNewRequest(`${site1}:${OPS_FAIL}`, 150);
            statsClient.reportNewRequest(`${site1}:${BYTES_DONE}`, 1027);
            statsClient.reportNewRequest(`${site1}:${BYTES_FAIL}`, 375);

            statsClient.reportNewRequest(`${site2}:${OPS}`, 900);
            statsClient.reportNewRequest(`${site2}:${BYTES}`, 2943);
            statsClient.reportNewRequest(`${site2}:${OPS_DONE}`, 300);
            statsClient.reportNewRequest(`${site2}:${OPS_FAIL}`, 55);
            statsClient.reportNewRequest(`${site2}:${BYTES_DONE}`, 1874);
            statsClient.reportNewRequest(`${site2}:${BYTES_FAIL}`, 575);

            done();
        });

        after(() => {
            redis.keys('*:test:bb:*').then(keys => {
                const pipeline = redis.pipeline();
                keys.forEach(key => {
                    pipeline.del(key);
                });
                return pipeline.exec();
            });
        });

        const metricsPaths = [
            '/_/metrics/crr/all',
            '/_/metrics/crr/all/backlog',
            '/_/metrics/crr/all/completions',
            '/_/metrics/crr/all/failures',
            '/_/metrics/crr/all/throughput',
        ];
        metricsPaths.forEach(path => {
            it(`should get a 200 response for route: ${path}`, done => {
                const url = getUrl(defaultOptions, path);

                http.get(url, res => {
                    assert.equal(res.statusCode, 200);
                    done();
                });
            });

            it(`should get correct data keys for route: ${path}`, done => {
                getRequest(path, (err, res) => {
                    assert.ifError(err);
                    const key = Object.keys(res)[0];
                    assert(res[key].description);
                    assert.equal(typeof res[key].description, 'string');

                    assert(res[key].results);
                    assert.deepEqual(Object.keys(res[key].results),
                        ['count', 'size']);
                    done();
                });
            });
        });

        const allWrongPaths = [
            // general wrong paths
            '/',
            '/metrics/crr/all',
            '/_/metrics',
            '/_/metrics/backlog',
            // wrong category field
            '/_/m/crr/all',
            '/_/metric/crr/all',
            '/_/metric/crr/all/backlog',
            '/_/metricss/crr/all',
            // wrong extension field
            '/_/metrics/c/all',
            '/_/metrics/c/all/backlog',
            '/_/metrics/crrr/all',
            // wrong site field
            // wrong type field
            '/_/metrics/crr/all/backlo',
            '/_/metrics/crr/all/backlogs',
            '/_/metrics/crr/all/completion',
            '/_/metrics/crr/all/completionss',
            '/_/metrics/crr/all/throughpu',
            '/_/metrics/crr/all/throughputs',
        ];
        allWrongPaths.forEach(path => {
            it(`should get a 404 response for route: ${path}`, done => {
                const url = getUrl(defaultOptions, path);

                http.get(url, res => {
                    assert.equal(res.statusCode, 404);
                    assert.equal(res.statusMessage, 'Not Found');
                    done();
                });
            });
        });

        it('should return an error for unknown site given', done => {
            getRequest('/_/metrics/crr/wrong-site/completions', err => {
                assert.equal(err.statusCode, 404);
                assert.equal(err.statusMessage, 'Not Found');
                done();
            });
        });

        it('should get the right data for route: ' +
        `/_/metrics/crr/${site1}/backlog`, done => {
            getRequest(`/_/metrics/crr/${site1}/backlog`, (err, res) => {
                assert.ifError(err);
                const key = Object.keys(res)[0];
                // Backlog count = OPS - OPS_DONE
                assert.equal(res[key].results.count, 1275);
                // Backlog size = BYTES - BYTES_DONE
                assert.equal(res[key].results.size, 1171);
                done();
            });
        });

        it('should get the right data for route: ' +
        '/_/metrics/crr/all/backlog', done => {
            getRequest('/_/metrics/crr/all/backlog', (err, res) => {
                assert.ifError(err);
                const key = Object.keys(res)[0];
                // Backlog count = OPS - OPS_DONE
                assert.equal(res[key].results.count, 1875);
                // Backlog size = BYTES - BYTES_DONE
                assert.equal(res[key].results.size, 2240);
                done();
            });
        });

        it('should get the right data for route: ' +
        `/_/metrics/crr/${site1}/completions`, done => {
            getRequest(`/_/metrics/crr/${site1}/completions`, (err, res) => {
                assert.ifError(err);
                const key = Object.keys(res)[0];
                // Completions count = OPS_DONE
                assert.equal(res[key].results.count, 450);
                // Completions bytes = BYTES_DONE
                assert.equal(res[key].results.size, 1027);
                done();
            });
        });

        it('should get the right data for route: ' +
        '/_/metrics/crr/all/completions', done => {
            getRequest('/_/metrics/crr/all/completions', (err, res) => {
                assert.ifError(err);
                const key = Object.keys(res)[0];
                // Completions count = OPS_DONE
                assert.equal(res[key].results.count, 750);
                // Completions bytes = BYTES_DONE
                assert.equal(res[key].results.size, 2901);
                done();
            });
        });

        it('should get the right data for route: ' +
        `/_/metrics/crr/${site1}/failures`, done => {
            getRequest(`/_/metrics/crr/${site1}/failures`, (err, res) => {
                assert.ifError(err);
                const key = Object.keys(res)[0];
                // Completions count = OPS_FAIL
                assert.equal(res[key].results.count, 150);
                // Completions bytes = BYTES_FAIL
                assert.equal(res[key].results.size, 375);
                done();
            });
        });

        it('should get the right data for route: ' +
        '/_/metrics/crr/all/failures', done => {
            getRequest('/_/metrics/crr/all/failures', (err, res) => {
                assert.ifError(err);
                const key = Object.keys(res)[0];
                // Completions count = OPS_FAIL
                assert.equal(res[key].results.count, 205);
                // Completions bytes = BYTES_FAIL
                assert.equal(res[key].results.size, 950);
                done();
            });
        });

        it('should get the right data for route: ' +
        `/_/metrics/crr/${site1}/throughput`, done => {
            getRequest(`/_/metrics/crr/${site1}/throughput`, (err, res) => {
                assert.ifError(err);
                const key = Object.keys(res)[0];
                // Throughput count = OPS_DONE / EXPIRY
                assert.equal(res[key].results.count, 0.5);
                // Throughput bytes = BYTES_DONE / EXPIRY
                assert.equal(res[key].results.size, 1.14);
                done();
            });
        });

        it('should get the right data for route: ' +
        '/_/metrics/crr/all/throughput', done => {
            getRequest('/_/metrics/crr/all/throughput', (err, res) => {
                assert.ifError(err);
                const key = Object.keys(res)[0];
                // Throughput count = OPS_DONE / EXPIRY
                assert.equal(res[key].results.count, 0.83);
                // Throughput bytes = BYTES_DONE / EXPIRY
                assert.equal(res[key].results.size, 3.22);
                done();
            });
        });

        it('should return all metrics for route: ' +
        `/_/metrics/crr/${site1}`, done => {
            getRequest(`/_/metrics/crr/${site1}`, (err, res) => {
                assert.ifError(err);
                const keys = Object.keys(res);
                assert(keys.includes('backlog'));
                assert(keys.includes('completions'));
                assert(keys.includes('throughput'));

                assert(res.backlog.description);
                // Backlog count = OPS - OPS_DONE
                assert.equal(res.backlog.results.count, 1275);
                // Backlog size = BYTES - BYTES_DONE
                assert.equal(res.backlog.results.size, 1171);

                assert(res.completions.description);
                // Completions count = OPS_DONE
                assert.equal(res.completions.results.count, 450);
                // Completions bytes = BYTES_DONE
                assert.equal(res.completions.results.size, 1027);

                assert(res.throughput.description);
                // Throughput count = OPS_DONE / EXPIRY
                assert.equal(res.throughput.results.count, 0.5);
                // Throughput bytes = BYTES_DONE / EXPIRY
                assert.equal(res.throughput.results.size, 1.14);

                done();
            });
        });

        it('should return all metrics for route: ' +
        '/_/metrics/crr/all', done => {
            getRequest('/_/metrics/crr/all', (err, res) => {
                assert.ifError(err);
                const keys = Object.keys(res);
                assert(keys.includes('backlog'));
                assert(keys.includes('completions'));
                assert(keys.includes('throughput'));

                assert(res.backlog.description);
                // Backlog count = OPS - OPS_DONE
                assert.equal(res.backlog.results.count, 1875);
                // Backlog size = BYTES - BYTES_DONE
                assert.equal(res.backlog.results.size, 2240);

                assert(res.completions.description);
                // Completions count = OPS_DONE
                assert.equal(res.completions.results.count, 750);
                // Completions bytes = BYTES_DONE
                assert.equal(res.completions.results.size, 2901);

                assert(res.throughput.description);
                // Throughput count = OPS_DONE / EXPIRY
                assert.equal(res.throughput.results.count, 0.83);
                // Throughput bytes = BYTES_DONE / EXPIRY
                assert.equal(res.throughput.results.size, 3.22);

                done();
            });
        });

        describe('No metrics data in Redis', () => {
            before(() => {
                redis.keys('*:test:bb:*').then(keys => {
                    const pipeline = redis.pipeline();
                    keys.forEach(key => {
                        pipeline.del(key);
                    });
                    return pipeline.exec();
                });
            });

            it('should return a response even if redis data does not exist',
            done => {
                getRequest('/_/metrics/crr/all', (err, res) => {
                    assert.ifError(err);

                    const keys = Object.keys(res);
                    assert(keys.includes('backlog'));
                    assert(keys.includes('completions'));
                    assert(keys.includes('throughput'));

                    assert(res.backlog.description);
                    assert.equal(res.backlog.results.count, 0);
                    assert.equal(res.backlog.results.size, 0.00);

                    assert(res.completions.description);
                    assert.equal(res.completions.results.count, 0);
                    assert.equal(res.completions.results.size, 0.00);

                    assert(res.throughput.description);
                    assert.equal(res.throughput.results.count, 0.00);
                    assert.equal(res.throughput.results.size, 0.00);

                    done();
                });
            });
        });
    });

    describe('CRR Retry routes', () => {
        let redisClient;

        before(() => {
            redisClient = new RedisClient(redisConfig, fakeLogger);
        });

        const retryPaths = [
            '/_/crr/failed',
            '/_/crr/failed/test-bucket/test-key?versionId=test-versionId',
        ];
        retryPaths.forEach(path => {
            it(`should get a 200 response for route: ${path}`, done => {
                const url = getUrl(defaultOptions, path);

                http.get(url, res => {
                    assert.equal(res.statusCode, 200);
                    done();
                });
            });
        });

        const retryQueryPaths = [
            '/_/crr/failed?marker=foo',
            '/_/crr/failed?marker=',
        ];
        retryQueryPaths.forEach(path => {
            it(`should get a 400 response for route: ${path}`, done => {
                const url = getUrl(defaultOptions, path);

                http.get(url, res => {
                    assert.equal(res.statusCode, 400);
                    done();
                });
            });
        });

        it('should get a 200 response for route: /_/crr/failed', done => {
            const keys = ['test-bucket:test-key:test-versionId:test-site'];
            setKey(redisClient, keys, err => {
                assert.ifError(err);
                const body = JSON.stringify([{
                    Bucket: 'test-bucket',
                    Key: 'test-key',
                    VersionId: 'test-versionId',
                    StorageClass: 'test-site',
                }]);
                return makeRetryPOSTRequest(body, (err, res) => {
                    assert.ifError(err);
                    assert.strictEqual(res.statusCode, 200);
                    done();
                });
            });
        });

        const invalidPOSTRequestBodies = [
            'a',
            {},
            [],
            ['a'],
            [{
                // Missing Bucket property.
                Key: 'b',
                VersionId: 'c',
                StorageClass: 'd',
            }],
            [{
                // Missing Key property.
                Bucket: 'a',
                VersionId: 'c',
                StorageClass: 'd',
            }],
            [{
                // Missing VersionId property.
                Bucket: 'a',
                Key: 'b',
                StorageClass: 'd',
            }],
            [{
                // Missing StorageClass property.
                Bucket: 'a',
                Key: 'b',
                VersionId: 'c',
            }],
        ];
        invalidPOSTRequestBodies.forEach(body => {
            const invalidBody = JSON.stringify(body);
            it('should get a 400 response for route: /_/crr/failed when ' +
            `given an invalid request body: ${invalidBody}`, done => {
                makeRetryPOSTRequest(invalidBody, (err, res) => {
                    assert.strictEqual(res.statusCode, 400);
                    return getResponseBody(res, (err, resBody) => {
                        assert.ifError(err);
                        const body = JSON.parse(resBody);
                        assert(body.MalformedPOSTRequest);
                        return done();
                    });
                });
            });
        });

        describe('Retry feature with Redis', () => {
            // Version ID calculated from the mock object MD.
            const testVersionId =
                '39383530303038363133343437313939393939395247303031202030';

            before(done => deleteKeys(redisClient, done));

            afterEach(done => deleteKeys(redisClient, done));

            it('should get correct data for GET route: /_/crr/failed when no ' +
            'key has been created', done => {
                getRequest('/_/crr/failed', (err, res) => {
                    assert.ifError(err);
                    assert.deepStrictEqual(res, {
                        IsTruncated: false,
                        Versions: [],
                    });
                    done();
                });
            });

            it('should get correct data for GET route: /_/crr/failed when ' +
            'the key has been created and there is one key', done => {
                const key = `test-bucket-1:test-key:${testVersionId}:test-site`;
                setKey(redisClient, [key], err => {
                    assert.ifError(err);
                    getRequest('/_/crr/failed?marker=0', (err, res) => {
                        assert.ifError(err);
                        assert.deepStrictEqual(res, {
                            IsTruncated: false,
                            Versions: [{
                                Bucket: 'test-bucket-1',
                                Key: 'test-key',
                                VersionId: testVersionId,
                                StorageClass: 'test-site',
                                Size: 1,
                                LastModified: '2018-03-30T22:22:34.384Z',
                            }],
                        });
                        done();
                    });
                });
            });

            it('should get correct data for GET route: /_/crr/failed when ' +
            'the key has been created and there are multiple key keys',
            done => {
                const keys = [
                    'test-bucket:test-key:test-versionId:test-site',
                    'test-bucket-1:test-key-1:test-versionId-1:test-site-1',
                    'test-bucket-2:test-key-2:test-versionId-2:test-site-2',
                ];
                setKey(redisClient, keys, err => {
                    assert.ifError(err);
                    getRequest('/_/crr/failed', (err, res) => {
                        assert.ifError(err);
                        assert.strictEqual(res.IsTruncated, false);
                        assert.strictEqual(res.Versions.length, 3);
                        // We cannot guarantee order because it depends on how
                        // Redis fetches the keys.
                        keys.forEach(k => {
                            // eslint-disable-next-line no-unused-vars
                            const [bucket, key, versionId, site] = k.split(':');
                            assert(res.Versions.some(o => (
                                o.Bucket === bucket &&
                                o.Key === key &&
                                o.VersionId === testVersionId &&
                                o.StorageClass === site
                            )));
                        });
                        done();
                    });
                });
            });

            it('should get correct data at scale for GET route: /_/crr/failed',
            function f(done) {
                this.timeout(30000);
                // Set non-matching keys so that recursive condition is met.
                async.timesLimit(500, 10, (i, next) => {
                    const keys = ['a', 'b', 'c', 'd', 'e'];
                    setDummyKey(redisClient, keys, next);
                }, err => {
                    if (err) {
                        return done(err);
                    }
                    return async.timesLimit(2000, 10, (i, next) => {
                        const keys = [
                            `bucket-${i}:key-${i}:versionId-${i}:site-${i}-a`,
                            `bucket-${i}:key-${i}:versionId-${i}:site-${i}-b`,
                            `bucket-${i}:key-${i}:versionId-${i}:site-${i}-c`,
                            `bucket-${i}:key-${i}:versionId-${i}:site-${i}-d`,
                            `bucket-${i}:key-${i}:versionId-${i}:site-${i}-e`,
                        ];
                        setKey(redisClient, keys, next);
                    }, err => {
                        assert.ifError(err);
                        const dummyKeyCount = 500 * 5;
                        const keyCount = 2000 * 5;
                        const scanCount = 1000;
                        const reqCount = (keyCount + dummyKeyCount) / scanCount;
                        const set = new Set();
                        let marker = 0;
                        async.timesSeries(reqCount, (i, next) =>
                            getRequest(`/_/crr/failed?marker=${marker}`,
                            (err, res) => {
                                assert.ifError(err);
                                res.Versions.forEach(version => {
                                    // Ensure we have no duplicate results.
                                    assert(!set.has(version.StorageClass));
                                    set.add(version.StorageClass);
                                });
                                if (res.IsTruncated === false) {
                                    assert.strictEqual(res.NextMarker,
                                        undefined);
                                    assert.strictEqual(set.size, keyCount);
                                    return done();
                                }
                                assert.strictEqual(res.IsTruncated, true);
                                assert.strictEqual(
                                    typeof(res.NextMarker), 'number');
                                marker = res.NextMarker;
                                return next();
                            }), done);
                    });
                });
            });

            it('should get correct data for GET route: ' +
            '/_/crr/failed/<bucket>/<key>?versionId=<versionId> when there ' +
            'is no key',
            done => {
                getRequest('/_/crr/failed/test-bucket/test-key?' +
                    'versionId=test-versionId',
                (err, res) => {
                    assert.ifError(err);
                    assert.deepStrictEqual(res, {
                        IsTruncated: false,
                        Versions: [],
                    });
                    done();
                });
            });

            it('should get correct data for GET route: ' +
            '/_/crr/failed/<bucket>/<key>?versionId=<versionId>', done => {
                const keys = [
                    'test-bucket:test-key/a:test-versionId:test-site',
                    'test-bucket:test-key/a:test-versionId:test-site-2',
                    'test-bucket-1:test-key-1/a:test-versionId-1:test-site',
                ];
                setKey(redisClient, keys, err => {
                    assert.ifError(err);
                    const route = '/_/crr/failed/test-bucket/test-key/a?' +
                        'versionId=test-versionId';
                    return getRequest(route, (err, res) => {
                        assert.ifError(err);
                        assert.strictEqual(res.IsTruncated, false);
                        assert.strictEqual(res.Versions.length, 2);
                        const matchingkeys = [keys[0], keys[1]];
                        matchingkeys.forEach(k => {
                            // eslint-disable-next-line no-unused-vars
                            const [bucket, key, versionId, site] = k.split(':');
                            assert(res.Versions.some(o => (
                                o.Bucket === bucket &&
                                o.Key === key &&
                                o.VersionId === testVersionId &&
                                o.StorageClass === site
                            )));
                        });
                        return done();
                    });
                });
            });

            it('should get correct data for GET route: /_/crr/failed when no ' +
            'key has been matched', done => {
                const body = JSON.stringify([{
                    Bucket: 'bucket',
                    Key: 'key',
                    VersionId: 'versionId',
                    StorageClass: 'site',
                }]);
                makeRetryPOSTRequest(body, (err, res) => {
                    assert.ifError(err);
                    getResponseBody(res, (err, resBody) => {
                        assert.ifError(err);
                        const body = JSON.parse(resBody);
                        assert.deepStrictEqual(body, []);
                        done();
                    });
                });
            });

            it('should get correct data for POST route: /_/crr/failed ' +
            'when there are multiple matching key keys', done => {
                const keys = [
                    `test-bucket:test-key:${testVersionId}:test-site-1`,
                    `test-bucket:test-key:${testVersionId}:test-site-2`,
                    `test-bucket:test-key:${testVersionId}:test-site-3`,
                ];
                setKey(redisClient, keys, err => {
                    assert.ifError(err);
                    const body = JSON.stringify([{
                        Bucket: 'test-bucket',
                        Key: 'test-key',
                        VersionId: testVersionId,
                        StorageClass: 'test-site-1',
                    }, {
                        Bucket: 'test-bucket',
                        Key: 'test-key',
                        VersionId: testVersionId,
                        // Should not be in response.
                        StorageClass: 'test-site-unknown',
                    }, {
                        Bucket: 'test-bucket',
                        Key: 'test-key',
                        VersionId: testVersionId,
                        StorageClass: 'test-site-2',
                    }, {
                        Bucket: 'test-bucket',
                        Key: 'test-key',
                        VersionId: testVersionId,
                        StorageClass: 'test-site-3',
                    }]);
                    makeRetryPOSTRequest(body, (err, res) => {
                        assert.ifError(err);
                        getResponseBody(res, (err, resBody) => {
                            assert.ifError(err);
                            const body = JSON.parse(resBody);
                            assert.deepStrictEqual(body, [{
                                Bucket: 'test-bucket',
                                Key: 'test-key',
                                VersionId: testVersionId,
                                StorageClass: 'test-site-1',
                                ReplicationStatus: 'PENDING',
                                LastModified: '2018-03-30T22:22:34.384Z',
                                Size: 1,
                            }, {
                                Bucket: 'test-bucket',
                                Key: 'test-key',
                                VersionId: testVersionId,
                                StorageClass: 'test-site-2',
                                ReplicationStatus: 'PENDING',
                                LastModified: '2018-03-30T22:22:34.384Z',
                                Size: 1,
                            }, {
                                Bucket: 'test-bucket',
                                Key: 'test-key',
                                VersionId: testVersionId,
                                StorageClass: 'test-site-3',
                                ReplicationStatus: 'PENDING',
                                LastModified: '2018-03-30T22:22:34.384Z',
                                Size: 1,
                            }]);
                            done();
                        });
                    });
                });
            });

            it('should get correct data at scale for POST route: /_/crr/failed',
            function f(done) {
                this.timeout(30000);
                const reqBody = [];
                async.timesLimit(10, 10, (i, next) => {
                    reqBody.push({
                        Bucket: `bucket-${i}`,
                        Key: `key-${i}`,
                        VersionId: testVersionId,
                        StorageClass: `site-${i}-a`,
                    }, {
                        Bucket: `bucket-${i}`,
                        Key: `key-${i}`,
                        VersionId: testVersionId,
                        StorageClass: `site-${i}-b`,
                    }, {
                        Bucket: `bucket-${i}`,
                        Key: `key-${i}`,
                        VersionId: testVersionId,
                        StorageClass: `site-${i}-c`,
                    }, {
                        Bucket: `bucket-${i}`,
                        Key: `key-${i}`,
                        VersionId: testVersionId,
                        StorageClass: `site-${i}-d`,
                    }, {
                        Bucket: `bucket-${i}`,
                        Key: `key-${i}`,
                        VersionId: testVersionId,
                        StorageClass: `site-${i}-e`,
                    });
                    const keys = [
                        `bucket-${i}:key-${i}:${testVersionId}:site-${i}-a`,
                        `bucket-${i}:key-${i}:${testVersionId}:site-${i}-b`,
                        `bucket-${i}:key-${i}:${testVersionId}:site-${i}-c`,
                        `bucket-${i}:key-${i}:${testVersionId}:site-${i}-d`,
                        `bucket-${i}:key-${i}:${testVersionId}:site-${i}-e`,
                    ];
                    setKey(redisClient, keys, next);
                }, err => {
                    assert.ifError(err);
                    const body = JSON.stringify(reqBody);
                    assert.ifError(err);
                    makeRetryPOSTRequest(body, (err, res) => {
                        assert.ifError(err);
                        getResponseBody(res, (err, resBody) => {
                            assert.ifError(err);
                            const body = JSON.parse(resBody);
                            assert.strictEqual(body.length, 10 * 5);
                            done();
                        });
                    });
                });
            });
        });
    });
});
