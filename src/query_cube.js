const toPairs = require("lodash").toPairs;
const values = require("lodash").values;
const isObject = require("lodash").isObject;
const isEmpty = require("lodash").isEmpty;
const inspect = require("util").inspect;

/**
 * Checks whether the pipeline can be rewritten:
 * Must start with $group stage and only contain $sum, $min,
 * $max, $avg aggregate functions.
 *
 * @param {Array<Object>} ppl   aggregation pipeline
 */

function checkCompatibility(ppl) {
  // for this proof of concept, we only support pipelines starting with a $group stage
  if (Object.keys(ppl[0])[0] !== "$group") {
    throw new Error("pipeline incompatible, must start with $group stage.");
  }

  // clone the pipeline
  ppl = JSON.parse(JSON.stringify(ppl));

  // extract group stage
  const group = ppl[0].$group;
  delete group._id;

  // check we only have supported aggregate operators
  const valid = values(group).every((val) => {
    const op = Object.keys(val)[0];
    return ["$sum", "$min", "$max", "$avg"].includes(op);
  });

  if (!valid) {
    throw new Error(
      "pipeline incompatible, only $sum, $min, $max, $avg aggregate functions supported."
    );
  }

  // construct the tuples for createPipeline
  const tuples = toPairs(group).map(([field, val]) => {
    let op = Object.keys(val)[0].slice(1);
    let meas = values(val)[0];
    if (isObject(meas) || meas === 1) {
      op = "count";
      meas = "$count";
    }
    meas = meas.slice(1);
    return [field, op, meas];
  });
  return tuples;
}

/**
 * Rewrites $group stage of the aggregation pipeline to query cube.
 *
 * @param {Array<Object>} ppl   aggregation pipeline
 * @param {Array<Array>} tuples  field,op,meas tuples returned from checkCompatibility()
 */
function createPipeline(ppl, tuples) {
  const measGroup = {};
  const measSet = {};
  const measProject = { _id: 1 };

  tuples.forEach(([f, a, m]) => {
    measProject[f] = `$${m}_${a}`;
    if (a === "count") {
      // for counts, sum over the top-level "count" field
      measGroup.count = { $sum: `$count` };
      // for counts, just project the top-level "count" field
      measProject[f] = "$count";
    } else if (a === "avg") {
      // for averages, we need the sum and count instead
      measGroup[`${m}_sum`] = { $sum: `$${m}.sum` };
      measGroup.count = { $sum: `$count` };
      // then we need a separate $set stage to calculate the new average
      measSet[`${m}_avg`] = { $divide: [`$${m}_sum`, `$count`] };
    } else {
      // in all other cases, we can apply the operator on the pre-aggregated values
      // e.g.  sum(a, b, c, d) = sum(sum(a, b), sum(c, d))
      measGroup[`${m}_${a}`] = { [`$${a}`]: `$${m}.${a}` };
    }
  });

  const oldGroup = ppl[0].$group;

  const group = {
    $group: {
      _id: oldGroup._id,
      ...measGroup,
    },
  };

  const set = {
    $set: measSet,
  };

  const project = {
    $project: measProject,
  };

  ppl = [group, ...(isEmpty(measSet) ? [] : [set]), project, ...ppl.slice(1)];
  return ppl;
}

/**
 * Rewrites $group stage of the aggregation pipeline to query a cube
 * created by createCube.
 *
 * Currently only works for pipelines where the first stage is $group,
 * and aggregate functions sum, min, max, avg.
 *
 * @param {Array<Object>} pipeline    aggregation pipeline
 */
function queryCube(pipeline) {
  const tuples = checkCompatibility(pipeline);
  return createPipeline(pipeline, tuples);
}

module.exports = queryCube;
