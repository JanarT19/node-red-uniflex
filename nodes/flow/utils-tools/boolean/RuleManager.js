"use strict";

let RED = null;

const operators = {
    eq: function (a, b) {
        return a == b;
    },
    neq: function (a, b) {
        return a != b;
    },
    lt: function (a, b) {
        return a < b;
    },
    lte: function (a, b) {
        return a <= b;
    },
    gt: function (a, b) {
        return a > b;
    },
    gte: function (a, b) {
        return a >= b;
    },
    btwn: function (a, b, c) {
        return a >= b && a <= c;
    },
    cont: function (a, b) {
        return (a + "").indexOf(b) != -1;
    },
    regex: function (a, b, c, d) {
        return (a + "").match(new RegExp(b, d ? "i" : ""));
    },
    true: function (a) {
        return a === true;
    },
    false: function (a) {
        return a === false;
    },
    null: function (a) {
        return typeof a == "undefined" || a === null;
    },
    nnull: function (a) {
        return typeof a != "undefined" && a !== null;
    }
};

const gates = {
    and: function (data) {
        return data.every(function (element) {
            if (element.hasOwnProperty("validated")) return element.validated;
            else return false;
        });
    },
    or: function (data) {
        return data.some(function (element) {
            if (element.hasOwnProperty("validated")) return element.validated;
            else return false;
        });
    },
    nand: function (data) {
        return !data.every(function (element) {
            if (element.hasOwnProperty("validated")) return element.validated;
            else return false;
        });
    },
    nor: function (data) {
        return !data.some(function (element) {
            if (element.hasOwnProperty("validated")) return element.validated;
            else return false;
        });
    },
    xor: function (data) {
        return (
            data.filter(function (element) {
                if (element.hasOwnProperty("validated")) return element.validated;
                else return false;
            }).length === 1
        );
    },
    xnor: function (data) {
        return (
            data.filter(function (element) {
                if (element.hasOwnProperty("validated")) return element.validated;
                else return false;
            }).length !== 1
        );
    }
};

// Calculate the number of validated rules and the total number of rules
const calculateLengths = (data) => {
    const validated = data.filter((element) => element.hasOwnProperty("validated") && element.validated).length;
    const total = data.length;

    return { validated, total };
};

// Get the previousValue and the optional topic of each rule
const getParameters = (data) => {
    return data.map((element) => {
        return {
            payload: element.previousValue,
            topic: element.topic
        };
    });
};

// Evaluate the value of a property, catching any errors (e.g. read properties of undefined : msg.payload.success)
const evaluate = (value, type, node, msg) => {
    try {
        return RED.util.evaluateNodeProperty(value, type, node, msg);
    } catch (err) {
        return undefined;
    }
};

class RuleManager {
    constructor(red, node, gate) {
        RED = red;

        this.data = [];
        this.node = node;
        this.gate = gate;
    }

    // Store all rules during the initialization
    storeRules(rules) {
        return new Promise((resolve, reject) => {
            for (let i = 0; i < rules.length; i++) {
                const row = rules[i];

                //Mandatory check
                if (!row.vt) {
                    if (!isNaN(Number(row.v))) {
                        row.vt = "num";
                    } else {
                        row.vt = "str";
                    }
                }

                if (row.vt === "num") {
                    if (!isNaN(Number(row.v))) {
                        row.v = Number(row.v);
                    }
                }

                if (typeof row.v2 !== "undefined") {
                    if (!row.v2t) {
                        if (!isNaN(Number(row.v2))) {
                            row.v2t = "num";
                        } else {
                            row.v2t = "str";
                        }
                    }

                    if (row.v2t === "num") {
                        row.v2 = Number(row.v2);
                    }
                }

                this.data.push(row);
            }

            this.updateState().then(resolve);
        });
    }

    // Update the state of the rules on new input message
    updateState(msg) {
        return new Promise((resolve, reject) => {
            for (let i = 0; i < this.data.length; i++) {
                const row = this.data[i];
                const test = evaluate(row.property, row.propertyType, this.node, msg);
                let v1, v2;

                switch (row.vt) {
                    case "prev": {
                        v1 = row.previousValue;
                        break;
                    }
                    case "msg":
                    case "flow":
                    case "global":
                    case "re":
                    case "bool": {
                        v1 = evaluate(row.v, row.vt, this.node, msg);
                        break;
                    }
                    default: {
                        // if the user set the value, take it
                        if (row.hasOwnProperty("v")) v1 = row.v;
                        break;
                    }
                }

                v2 = row.v2;

                switch (row.v2t) {
                    case "prev": {
                        v2 = row.previousValue;
                        break;
                    }
                    case "msg":
                    case "flow":
                    case "global":
                    case "re":
                    case "bool": {
                        if (typeof v2 !== undefined) {
                            v2 = evaluate(row.v2, row.v2t, this.node, msg);
                        }

                        break;
                    }
                    default: {
                        if (typeof v2 !== undefined) {
                            v2 = evaluate(row.v2, row.v2t, this.node, msg);
                        }

                        // if the user set the value, take it
                        if (row.hasOwnProperty("v")) v2 = row.v2;
                        break;
                    }
                }

                //Check if the rule is ok
                if (msg) {
                    // if the rule match with the message got
                    if ((row.propertyType === "msg" && (!row.topic || msg.topic === row.topic)) || row.propertyType !== "msg") {
                        row.validated = operators[row.t](test, v1, v2, row.case);
                        row.previousValue = test;
                    }
                } else {
                    // if the rule isn't about a message
                    if (row.propertyType !== "msg") {
                        row.validated = operators[row.t](test, v1, v2, row.case);
                        row.previousValue = test;
                    }
                }
            }

            const result = gates[this.gate](this.data);
            const metadata = calculateLengths(this.data);
            const parameters = getParameters(this.data);

            resolve({ result, parameters, metadata });
        });
    }
}

module.exports = RuleManager;
