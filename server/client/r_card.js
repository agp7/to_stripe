const router = require('express').Router();
const data = require('./data.js');
const validar = require('./validar');
var crypto = require('crypto');
const { base64encode } = require('nodejs-base64');
var request = require('request');
var feedback = require('./feedback.js');
var app = require('../app.js');

//PRODUCTION
var paymentez_url = 'https://ccapi.paymentez.com/';

//DEVELOPER
if (_ENVIRONMENT_ === 'developing') {
    paymentez_url = 'https://ccapi-stg.paymentez.com/';
}

router.post('/listar/', function (req, res) {
    var referencia = req.headers.referencia;
    if (referencia !== '12.03.91')
        return res.status(320).send({ error: 'Deprecate' });
    var idplataforma = req.headers.idplataforma;
    var imei = req.headers.imei;
    return listar(req, res, idplataforma, imei);
});

function listar(req, res, idplataforma, imei) {
    var idaplicativo = req.headers.idaplicativo;
    var idCliente = req.body.idCliente;
    var auth = req.body.auth;
 
    validar.token(idCliente, auth, idplataforma, imei, res, function (autorizado, cliente) {
        if (!autorizado)
            return;
        var auth_token = authToken(idaplicativo);
        let options = {
            headers: {
                'Auth-Token': auth_token,
                'Content-Type': 'application/json'
            },
            method: 'GET',
            url: `${paymentez_url}v2/card/list?uid=${idCliente}`
        };
        request(options, function (error, response, body) {
            var cardes = [];
            data.consultarRes(STORE_CUPONES, [idCliente], function (cupones) {
                if (cupones.length > 0)
                    cardes.push.apply(cardes, cupones);
                cardes.push.apply(cardes, JSON.parse(response.body)['cards']);
                return res.status(200).send({ estado: 1, cardes: cardes });
            }, res);
        });
    });
}

const STORE_CUPONES =
    "SELECT id_cupon, id_agencia, id_forma_pago, cupon, mensaje, bin, terminos, `status`, token, holder_name, modo, `type`, `number` FROM " + _STORE_ + "_rubro.cupon c WHERE c.id_cliente = ? AND cupon > 0;";


router.post('/debitar/', function (req, res) {
    var referencia = req.headers.referencia;
    if (referencia !== '12.03.91')
        return res.status(320).send({ error: 'Deprecate' });
    var idplataforma = req.headers.idplataforma;
    var imei = req.headers.imei;
    return debitar(req, res, idplataforma, imei);
});


const STORE_VERIFICAR_CHASH =
    "SELECT IFNULL(MAX(cash), 0.0) AS cash FROM " + _STORE_ + ".saldo s WHERE s.id_cliente = ? LIMIT 1;";

function debitar(req, res, idplataforma, imei) {
    var idaplicativo = req.headers.idaplicativo;
    var idCliente = req.body.idCliente;
    var auth = req.body.auth;
    var token = req.body.token;
    var cash = req.body.cash;
    var detalle = `${app.nombre(idaplicativo)} APP ${req.body.detalle}`;

    var description = `${detalle.substring(0, 230)}`;  //Descripción de la orden a ser comprada. Formato: (Longitud Maxima 250)
    var amount = req.body.amount; //Monto a cobrar. Formato: decimal con dos dígitos de fracción.
    if (!amount || amount == null || amount == 'null' || isNaN(amount))
        return res.status(200).send({ estado: -1, error: 'Intenta de nuevo mas tarde.' });
    try {
        amount = parseFloat(amount);
    } catch (err) {
        console.log(err);
        return res.status(200).send({ estado: -1, error: 'Intenta de nuevo mas tarde.' });
    }
    var idTransaccion = 0//Referencia de la orden en el comercio. Usted identificará esta compra utilizando esta referencia

    var ip = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.socket.remoteAddress || (req.connection.socket ? req.connection.socket.remoteAddress : null);

    validar.token(idCliente, auth, idplataforma, imei, res, function (autorizado, cliente) {
        if (!autorizado)
            return;
        var email = cliente['correo'];
        var phone = `${cliente['celular']}`;
        var nombres = cliente['nombres'];
        delete req.body['auth'];

        data.consultarRes(STORE_VERIFICAR_CHASH, [idCliente], function (cashs) {
            if (cashs.length <= 0)
                return res.status(200).send({ estado: -1, error: 'Intenta de nuevo mas tarde.' });
            var cashCliente = cashs[0]['cash'];
            if (cashCliente < cash)
                return res.status(200).send({ estado: -1, error: 'Valores no cuadra, intenta de nuevo mas tarde.' });
            if (amount <= 0)
                return res.status(200).send({ estado: 1, status: STATUS_SUSSES, id_transaccion: idTransaccion });

            var tax_percentage = 12;//Solo disponible para Ecuador. La tasa de impuesto que se aplicará a este pedido. Debe de ser 0 o 12.
            var taxable_amount = (amount / 1.12).toFixed(2);
            taxable_amount = parseFloat(taxable_amount);
            var vat = (amount - taxable_amount).toFixed(2);//Importe del impuesto sobre las ventas, incluido en el costo del producto. Formato: decimal con dos dígitos de fracción.
            vat = parseFloat(vat);
            data.consultarRes(STORE_REGISTRAR_TRANSACCION, [idCliente, amount, detalle, JSON.stringify(req.body), JSON.stringify(req.headers)], function (registro) {
                idTransaccion = registro['insertId'];
                if (idTransaccion <= 0)
                    return res.status(200).send({ estado: -1, error: 'Lo sentimos intenta de nuevo mas tarde' });

                var auth_token = authToken(idaplicativo);
                let options = {
                    headers: {
                        'Auth-Token': auth_token,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        "card": {
                            "token": token
                        },
                        "user": {
                            "id": idCliente,
                            "email": email,
                            "ip_address": ip,
                            "phone": phone
                        },
                        "order": {
                            "amount": amount,
                            "description": description,
                            "dev_reference": `${idCliente}-${idTransaccion}`,
                            "vat": vat,
                            "taxable_amount": taxable_amount,
                            "tax_percentage": tax_percentage
                        }
                    }),
                    method: 'POST',
                    url: `${paymentez_url}v2/transaction/debit/`
                };
                request(options, function (error, response, body) {
                    try {
                        let response = JSON.parse(body);
                        if (response.transaction['status'] == 'success') {
                            data.consultarRes(STORE_REGISTRAR_RESPUESTA, [STATUS_SUSSES, JSON.stringify(response), idTransaccion], function () {
                                var id = response.transaction['id'];
                                var code = response.transaction['authorization_code'];
                                feedback.notificarCompra(idaplicativo, idCliente, nombres, email, detalle, amount.toFixed(2), id, code);
                                return res.status(200).send({ estado: 1, status: STATUS_SUSSES, id_transaccion: idTransaccion, error: '¡Transacción realizada correctamente!' });
                            }, res);
                            return;
                        }
                        else if (response.transaction['status'] == 'pending') {
                            data.consultar(STORE_REGISTRAR_RESPUESTA, [STATUS_PEDING, JSON.stringify(response), idTransaccion]);
                            return res.status(200).send({ estado: 1, status: STATUS_PEDING, id_transaccion: idTransaccion });
                        }
                        else {
                            data.consultar(STORE_REGISTRAR_RESPUESTA, [STATUS_ERROR, JSON.stringify(response), idTransaccion]);
                            return res.status(200).send({ estado: 0, status: STATUS_ERROR, id_transaccion: idTransaccion, error: 'Transacción rechazada. Intenta de nuevo mas tarde.' });
                        }
                    } catch (err) {
                        console.log(err);
                        data.consultar(STORE_REGISTRAR_RESPUESTA, [STATUS_ERROR, JSON.stringify(body), idTransaccion]);
                        return res.status(200).send({ estado: 0, status: STATUS_ERROR, id_transaccion: idTransaccion, error: 'Transacción rechazada. Intenta de nuevo mas tarde.' });
                    }
                });
            }, res);
        }, res);
    });
}

const STATUS_SUSSES = 200;
const STATUS_PEDING = 300;
const STATUS_ERROR = 500;

const STORE_REGISTRAR_TRANSACCION =
    "INSERT INTO " + _STORE_ + "_rubro.`cash` (`id_cliente`, `cash`, `detalle`, `body`, `header`) VALUES (?, ?, ?, ?, ?);";

const STORE_REGISTRAR_RESPUESTA =
    "UPDATE " + _STORE_ + "_rubro.cash SET `status` = ?, response = ?, fecha_response = NOW() WHERE id_cash = ? LIMIT 1;";

const STORE_REGISTRAR_OTP =
    "UPDATE " + _STORE_ + "_rubro.cash SET `status` = ?, otp = ?, fecha_otp = NOW() WHERE id_cash = ? LIMIT 1;";

router.post('/autorizar/', function (req, res) {
    var referencia = req.headers.referencia;
    if (referencia !== '12.03.91')
        return res.status(320).send({ error: 'Deprecate' });
    var idplataforma = req.headers.idplataforma;
    var imei = req.headers.imei;
    return autorizar(req, res, idplataforma, imei);
});

//Se llama cuando el sistema pide OTP solo al momento de realizar una compra
function autorizar(req, res, idplataforma, imei) {
    var idaplicativo = req.headers.idaplicativo;
    var idCliente = req.body.idCliente;
    var auth = req.body.auth;
    var value = req.body.value;
    var idTransaccion = req.body.idTransaccion;
    validar.token(idCliente, auth, idplataforma, imei, res, function (autorizado, cliente) {
        if (!autorizado)
            return;
        var email = cliente['correo'];
        var nombres = cliente['nombres'];
        data.consultarRes(STORE_CONSULTAR_TRANSACCION, [idTransaccion], function (transacciones) {

            if (transacciones.length <= 0)
                return res.status(200).send({ estado: -1, error: 'Lo sentimos intenta de nuevo mas tarde =(' });

            var response = JSON.parse(transacciones[0]['response']);
            var transaction = response['transaction'];
            // var type = transaction['carrier_code'];
            var type = 'BY_OTP';
            var typeCard = response.card['type'];
            var id = transaction['id'];
            var code = transaction['authorization_code']
            if (!code || code == "null" || code == null)
                code = id;

            var amount = transacciones[0]['cash'];
            var detalle = transacciones[0]['detalle'];
            var auth_token = authToken(idaplicativo);
            let options = {
                headers: {
                    'Auth-Token': auth_token,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    "transaction": {
                        "id": id
                    },
                    "user": {
                        "id": idCliente
                    }
                    ,
                    "type": type,
                    "value": value,
                    "more_info": false
                }),
                method: 'POST',
                url: `${paymentez_url}v2/transaction/verify`
            };
            request(options, function (error, response, body) {
                try {
                    let response = JSON.parse(body);
                    if (response.status == 1) {
                        data.consultar(STORE_REGISTRAR_OTP, [STATUS_SUSSES, JSON.stringify(response), idTransaccion]);
                        feedback.notificarCompra(idaplicativo, idCliente, nombres, email, detalle, amount.toFixed(2), id, code);
                        return res.status(200).send({ estado: 1, status: STATUS_SUSSES, id_transaccion: idTransaccion, error: '¡Transacción realizada correctamente!' });
                    } else {
                        data.consultar(STORE_REGISTRAR_OTP, [STATUS_ERROR, JSON.stringify(response), idTransaccion]);
                        return res.status(200).send({ estado: 0, status: STATUS_ERROR, id_transaccion: idTransaccion, error: 'Transacción rechazada. Intenta de nuevo mas tarde. XD' });
                    }
                } catch (err) {
                    data.consultar(STORE_REGISTRAR_OTP, [STATUS_ERROR, JSON.stringify(body), idTransaccion]);
                    return res.status(200).send({ estado: 0, status: STATUS_ERROR, id_transaccion: idTransaccion, error: 'Transacción rechazada. Intenta de nuevo mas tarde...' });
                }
            });
        });
    });
}

const STORE_CONSULTAR_TRANSACCION =
    "SELECT cash, detalle, response, IF(status_reembolso IS NOT NULL, 'success', status_reembolso) AS status_reembolso, reembolso FROM " + _STORE_ + "_rubro.cash c WHERE c.id_cash = ? LIMIT 1;";

router.post('/eliminar/', function (req, res) {
    var referencia = req.headers.referencia;
    if (referencia !== '12.03.91')
        return res.status(320).send({ error: 'Deprecate' });
    var idplataforma = req.headers.idplataforma;
    var imei = req.headers.imei;
    return eliminar(req, res, idplataforma, imei);
});

function eliminar(req, res, idplataforma, imei) {
    var idaplicativo = req.headers.idaplicativo;
    var idCliente = req.body.idCliente;
    var auth = req.body.auth;
    var token = req.body.token;
    validar.token(idCliente, auth, idplataforma, imei, res, function (autorizado, cliente) {
        if (!autorizado)
            return;
        var auth_token = authToken(idaplicativo);
        let options = {
            headers: {
                'Auth-Token': auth_token,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                "card": {
                    "token": token
                },
                "user": {
                    "id": idCliente
                }
            }),
            method: 'POST',
            url: `${paymentez_url}v2/card/delete/`
        };
        request(options, function (error, response, body) {
            return res.status(200).send({ estado: 1 });
        });
    });
}

//Se llama cuando el sistema pide OTP solo al momento de registrar una tarjeta nueva
router.post('/verificar/', function (req, res) {
    var referencia = req.headers.referencia;
    if (referencia !== '12.03.91')
        return res.status(320).send({ error: 'Deprecate' });
    var idplataforma = req.headers.idplataforma;
    var imei = req.headers.imei;
    return verificar(req, res, idplataforma, imei);
});

function verificar(req, res, idplataforma, imei) {
    var idaplicativo = req.headers.idaplicativo;
    var idCliente = req.body.idCliente;
    var auth = req.body.auth;
    var transactionId = req.body.transactionId;
    var type = req.body.type;
    var value = req.body.value;
    validar.token(idCliente, auth, idplataforma, imei, res, function (autorizado, cliente) {
        if (!autorizado)
            return;
        var auth_token = authToken(idaplicativo);
        let options = {
            headers: {
                'Auth-Token': auth_token,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                "transaction": {
                    "id": transactionId
                },
                "user": {
                    "id": idCliente
                }
                ,
                "type": type,
                "value": value,
                "more_info": false
            }),
            method: 'POST',
            url: `${paymentez_url}v2/transaction/verify`
        };
        request(options, function (error, response, body) {
            let idTransaccion = '0';//No hay pues es regitro
            try {
                let response = JSON.parse(body);
                if (response.status == 1)
                    return res.status(200).send({ estado: 1, status: STATUS_SUSSES, id_transaccion: idTransaccion, error: '¡Transacción realizada correctamente!' });
                return res.status(200).send({ estado: 0, status: STATUS_ERROR, id_transaccion: idTransaccion, error: 'Transacción rechazada. Intenta de nuevo mas tarde.' });
            } catch (err) {
                console.log('Error :', err)
                return res.status(200).send({ estado: 0, status: STATUS_ERROR, id_transaccion: idTransaccion, error: 'Transacción rechazada. Intenta de nuevo mas tarde.' });
            }
        });
    });
}

router.get('/reembolsar/:idCliente/:idCompra/:token/:idTransaccion/:idDespacho/:amount/:idaplicativo', function (req, res) {
    return reembolsar(req, res);
});

function reembolsar(req, res) {
    var idaplicativo = req.params.idaplicativo;
    var idCliente = req.params.idCliente;
    var amount = req.params.amount; //Monto a reembolsar. Formato: decimal con dos dígitos de fracción.
    var idCompra = req.params.idCompra;
    var token = req.params.token;
    var idTransaccion = req.params.idTransaccion;
    var idDespacho = req.params.idDespacho;

    if (!amount || amount == null || amount == 'null' || isNaN(amount))
        return res.status(200).send({ estado: -1, error: 'Erorr' });
    try {
        amount = parseFloat(amount);
    } catch (err) {
        console.log(err);
        return res.status(200).send({ estado: -2, error: 'Erorr' });
    }

    data.consultarRes(STORE_VER_BOT_CURIOSITY, [idCompra, idDespacho, idCliente, idCliente, idCompra, token], function (compras) {
        if (compras.length <= 0)
            return res.status(200).send({ estado: 0, error: 'Compra no CANCELADA. El reembolso no se puede efectuar.' });

        data.consultarRes(STORE_CONSULTAR_TRANSACCION, [idTransaccion], function (transacciones) {
            if (transacciones.length <= 0)
                return res.status(200).send({ estado: -1, error: 'La transacción no existe.' });

            if (transacciones[0]['status_reembolso'] == 'success')
                return res.status(200).send({ estado: 1, error: 'REVERSO YA SOLICITADO', reembolso: transacciones[0]['reembolso'] });

            var transaction = JSON.parse(transacciones[0]['response'])['transaction'];
            var id = transaction['id'];
            var auth_token = authToken(idaplicativo);

            data.consultarRes(STORE_REGISTRAR_REEMBOLSO, [amount, idTransaccion], function () {
                let options = {
                    headers: {
                        'Auth-Token': auth_token,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        "transaction": {
                            "id": id
                        }
                    }),
                    method: 'POST',
                    url: `${paymentez_url}v2/transaction/refund/`
                };
                request(options, function (error, response, body) {
                    try {
                        let response = JSON.parse(body);
                        if (response['status'] == 'success') {
                            data.consultar(STORE_AUTORIZO_REEMBOLSO, [STATUS_REEMBOLSO_SUSSES, JSON.stringify(response), idTransaccion]);
                            return res.status(200).send({ estado: 1, status: STATUS_REEMBOLSO_SUSSES, id_transaccion: idTransaccion, body: body });
                        }
                        else if (response['status'] == 'pending') {
                            data.consultar(STORE_AUTORIZO_REEMBOLSO, [STATUS_REEMBOLSO_PEDING, JSON.stringify(response), idTransaccion]);
                            return res.status(200).send({ estado: 1, status: STATUS_REEMBOLSO_PEDING, id_transaccion: idTransaccion, body: body });
                        }
                        else {
                            data.consultar(STORE_AUTORIZO_REEMBOLSO, [STATUS_REEMBOLSO_ERROR, JSON.stringify(response), idTransaccion]);
                            return res.status(200).send({ estado: 0, status: STATUS_REEMBOLSO_ERROR, id_transaccion: idTransaccion, body: body });
                        }
                    } catch (err) {
                        console.log(err);
                        data.consultar(STORE_AUTORIZO_REEMBOLSO, [STATUS_REEMBOLSO_ERROR, JSON.stringify(body), idTransaccion]);
                        return res.status(200).send({ estado: 0, status: STATUS_REEMBOLSO_ERROR, id_transaccion: idTransaccion, body: body });
                    }
                });
            }, res);
        }, res);
    }, res);
}

const STORE_VER_BOT_CURIOSITY =
    "SELECT com.id_compra FROM  " + _STORE_ + ".compra com "
    + " WHERE com.id_compra = ? AND com.id_despacho = ? AND com.id_cliente = ? AND com.id_compra_estado = 100 AND MD5(CONCAT(MD5(?),'JP_DESERT7&12992', ?)) = ? LIMIT 1;";

const STATUS_REEMBOLSO_SUSSES = 200;
const STATUS_REEMBOLSO_PEDING = 300;
const STATUS_REEMBOLSO_ERROR = 500;

const STORE_REGISTRAR_REEMBOLSO =
    "UPDATE " + _STORE_ + "_rubro.`cash` SET reembolso_cash = ?, `status_reembolso` = '100', `fecha_reembolso` = NOW() WHERE `id_cash` = ? LIMIT 1;";

const STORE_AUTORIZO_REEMBOLSO =
    "UPDATE " + _STORE_ + "_rubro.`cash` SET `status_reembolso` = ?, `reembolso` = ?, `fecha_autorizo_reembolso` = NOW() WHERE `id_cash` = ? AND reembolso IS NULL LIMIT 1;";

router.post('/canjear/', function (req, res) {
    var referencia = req.headers.referencia;
    if (referencia !== '12.03.91')
        return res.status(320).send({ error: 'Deprecate' });
    var idplataforma = req.headers.idplataforma;
    var imei = req.headers.imei;
    return canjear(req, res, idplataforma, imei);
});

function canjear(req, res, idplataforma, imei) {
    var idCliente = req.body.idCliente;
    var auth = req.body.auth;
    var codigo = req.body.codigo;
    validar.token(idCliente, auth, idplataforma, imei, res, function (autorizado, cliente) {
        if (!autorizado)
            return;
        data.consultarRes(STORE_CANJEAR, [idCliente, codigo], function (respuesta) {
            if (respuesta['affectedRows'] <= 0)
                return res.status(200).send({ estado: 0, error: 'Lo sentimos el código es incorrecto' });
            data.consultarRes(STORE_CUPON, [codigo], function (cupones) {
                if (cupones.length <= 0)
                    return res.status(200).send({ estado: 0, error: 'Lo sentimos el código es incorrecto' });
                return res.status(200).send({ estado: 1, error: cupones[0]['saludo'], card: cupones[0] });
            }, res);
        }, res);
    });
}

const STORE_CANJEAR =
    "UPDATE " + _STORE_ + ".`gift` SET `canejada` = '1', `id_cliente_canjeo` = ?, `fecha_canjeada` = NOW() WHERE codigo = ? AND canejada = 0;";

const STORE_CUPON =
    "SELECT id_cupon, id_agencia, id_forma_pago, saludo, cupon, mensaje, bin, terminos, `status`, token, holder_name, modo, `type`, `number` FROM " + _STORE_ + "_rubro.cupon c WHERE c.codigo = ?;";

function authToken(idaplicativo) {
    let server_application_code = app.code_PMZ(idaplicativo);
    let server_app_key = app.key_PMZ(idaplicativo);

    var unix_timestamp = parseInt(Date.now() / 1000);
    var uniq_token_string = `${server_app_key}${unix_timestamp}`;
    var uniq_token_hash = crypto.createHash('sha256').update(uniq_token_string).digest('hex');
    return base64encode(`${server_application_code};${unix_timestamp};${uniq_token_hash}`)
}

module.exports = router;