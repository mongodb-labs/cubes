const zipObject = require("lodash").zipObject;

/**
 * returns a pipeline to create a cube over the given dimensions and measures.
 *
 * @param {Array<String>} dimensions  all dimensions to group by
 * @param {Array<String>} measures  all measures to aggregate over
 */
function createCube(dimensions, measures, outCollection) {
  // replace dots with underscores
  const dashedDimensions = dimensions.map((d) => d.replace(".", "_"));
  const dollaredDimensions = dimensions.map((d) => `$${d}`);

  const mapMeasure = (measure) => {
    const sumField = `${measure}_sum`;
    const minField = `${measure}_min`;
    const maxField = `${measure}_max`;
    const countField = `${measure}_count`;

    return {
      [sumField]: { $sum: `$${measure}` },
      [minField]: { $min: `$${measure}` },
      [maxField]: { $max: `$${measure}` },
      [countField]: {
        $sum: { $cond: { if: `$${measure}`, then: 1, else: 0 } },
      },
    };
  };

  const mappedMeasures = measures.reduce((acc, val) => {
    return { ...acc, ...mapMeasure(val) };
  }, {});

  // cleaning up measures (create measure.min, measure.max etc.)
  const nestedMeasure = (measure) => {
    const sumField = `$${measure}_sum`;
    const minField = `$${measure}_min`;
    const maxField = `$${measure}_max`;
    const countField = `$${measure}_count`;

    return {
      [measure]: {
        sum: sumField,
        min: minField,
        max: maxField,
        count: countField,
      },
    };
  };

  const nestedMeasures = measures.reduce((acc, val) => {
    return { ...acc, ...nestedMeasure(val) };
  }, {});

  // cleaning up dimensions (lifting them to the root level)
  const _idDimensions = dashedDimensions.map((d) => `$_id.${d}`);
  const unwrappedDimensions = zipObject(dimensions, _idDimensions);

  return [
    {
      $group: {
        _id: zipObject(dashedDimensions, dollaredDimensions),
        count: { $sum: 1 },
        ...mappedMeasures,
      },
    },
    {
      $project: {
        _id: 0,
        count: 1,
        ...nestedMeasures,
        ...unwrappedDimensions,
      },
    },
    { $out: outCollection },
  ];
}

module.exports = createCube;
