# OLAP Cubing for MongoDB

This repository demonstrates the basic idea of creating and querying OLAP Cubes using the MongoDB Aggregation Framework. It accompanies the talk I presented at MongoDB World 2022 "Materialized Pre-Aggregations for Exploratory Analytics Queries".

An OLAP Cube can be seen as a pre-aggregated view of a dataset along certain dimensions of interest. The data is processed in a way that allows for fast ad-hoc analytics queries over the chosen dimensions for the purpose of data exploration or visualisation.

## Disclaimer

Note that this implementation is not officially endorsed or supported by MongoDB Inc. and should not be relied on in production systems. The code provided here is for educational purposes only.

## Installation

Install the module in the local folder from where you will start the `mongosh` shell with npm:

```
npm install cubes
```

You will need a mongod server running locally. Here we assume the standard port 27017. Launch the (new) mongo shell with:

```
mongosh
```

Now import the module by typing:

```js
const cubes = require("cubes");
```

## API

The `cubes` module provides 2 functions: `createCube()` to create a materialized view and `queryCube()` to query the view.

### cubes.createCube(dimensions, measures, viewName)

`createCube()` expects 3 arguments: An array of dimensions, an array of measures and the name of the materialized view. It returns an aggregation pipeline to create the materialized view, which can be executed against the dataset.

```js
// create the pipeline
const cubePipeline = cubes.createCube(dimensions, measures, viewName);

// execute it against collection
db.collection.aggregate(cubePipeline);
```

### cubes.queryCube(pipeline)

To query a cube instead of the original dataset, the pipeline needs to be modified slightly. `queryCube()` takes care of rewriting the pipeline. It takes a pipeline as its only argument and returns the modified pipeline, which can then be executed against the materialized view.

This implemention currently only supports pipelines that start with a `$group` stage, i.e. there can't be any filters or transformations in front of the grouping.

```js
// assuming original pipeline "p" and view name "cube"
db.cube.aggregate(cubes.queryCube(p));
```

## Example

### DMV Dataset

The examples below use the DMV dataset. To follow along with the examples, you can download the DMV dataset here. Load the dataset into the `datasets.dmv` namespace on your local mongod server with:

```
mongorestore -d datasets -c dmv dump/datasets/dmv.bson
```

### Creating a Cube

To create a cube, we use the `cubes.createCube()` function.

In this example, we want to create a cube over the dimensions `State`, `Color`, `Suspension Indicator` and `Model Year` and include a single measure `Unladen Weight`. We name the output collection `dmv.cube`.

```js
const cubePipeline = cubes.createCube(
  ["State", "Color", "Suspension Indicator", "Model Year"],
  ["Unladen Weight"],
  "dmv.cube"
);
```

For our example, the `createCube()` function returns the following aggregation pipeline:

```js
[
  {
    $group: {
      _id: {
        State: "$State",
        Color: "$Color",
        "Suspension Indicator": "$Suspension Indicator",
        "Model Year": "$Model Year",
      },
      count: { $sum: 1 },
      "Unladen Weight_sum": { $sum: "$Unladen Weight" },
      "Unladen Weight_min": { $min: "$Unladen Weight" },
      "Unladen Weight_max": { $max: "$Unladen Weight" },
      "Unladen Weight_count": {
        $sum: { $cond: { if: "$Unladen Weight", then: 1, else: 0 } },
      },
    },
  },
  {
    $project: {
      _id: 0,
      count: 1,
      "Unladen Weight": {
        sum: "$Unladen Weight_sum",
        min: "$Unladen Weight_min",
        max: "$Unladen Weight_max",
        count: "$Unladen Weight_count",
      },
      State: "$_id.State",
      Color: "$_id.Color",
      "Suspension Indicator": "$_id.Suspension Indicator",
      "Model Year": "$_id.Model Year",
    },
  },
  { $out: "dmv.cube" },
];
```

Note that for each provided measure field, the `sum`, `min`, `max` and `count` aggregates are calculated. In addition, the overall count of documents is also calculated.

Averages are also supported, but are computed when querying the cube using sums and counts, and therefore don't need to be stored separately. Other aggregate functions are not supported in this implementation.

Now we need to execute the cube pipeline against the original dataset. The results will be stored in the `dmv.cube` collection. This step can take several minutes.

```js
db.dmv.aggregate(cubePipeline);
```

You can verify that the cube was created by inspecting the materialized view:

```js
db.dmv.cube.findOne();
```

This will return a document similar to the one below:

```js
{
  _id: ObjectId("629cd9c98308c5c6a2f037a7"),
  count: 2,
  'Unladen Weight': { sum: 5650, min: 2800, max: 2850, count: 2 },
  State: 'NY',
  Color: 'DK BL',
  'Suspension Indicator': 'N',
  'Model Year': 1940
}
```

### Querying the Cube

As a first example, we want to retrieve the total document count, which can be expressed as a `$group` operation over a constant dimension (we can use `null` for the `_id` field):

```js
const p1 = [{ $group: { _id: null, count: { $sum: 1 } } }];
```

This pipeline would work against the original dataset, but when issued against the materialized view, it needs to be modified. We can inspect the result of `cubes.queryCube(p1)` to see the rewritten pipeline:

```js
[
  { $group: { _id: null, count: { $sum: "$count" } } },
  { $project: { _id: 1, count: "$count" } },
];
```

Instead of adding 1 for each document, it sums up the `counts`. It also added a `$project` stage. In this simple example, the additional `$project` stage is a no-op, but for more complex aggregations (like the one below), it cleans up the result and ensures that the result looks exactly like the one of the original pipeline.

Now we can compare the results querying the collection vs. querying the cube:

```
// took 7.3 seconds
datasets> db.dmv.aggregate(p1)
[ { _id: null, count: 11591877 } ]

// took 40 milliseconds
datasets> db.dmv.cube.aggregate(cubes.queryCube(p1))
[ { _id: null, count: 11591877 } ]
```

The only difference is performance. The second operation runs orders of magnitudes faster than the first.

Now we use a more complex aggregation: We want to determine the average weight of vehicles for each year, and retrieve the top 3 years with heaviest vehicles on average:

The aggregation pipeline for this operation looks like this:

```js
const p2 = [
  {
    $group: {
      _id: "$Model Year",
      avg_weight: {
        $avg: "$Unladen Weight",
      },
    },
  },
  { $sort: { avg_weight: -1 } },
  { $limit: 3 },
];
```

To see the rewritten pipeline, again we can inspect the result of `cubes.queryCube(p2)`, which is:

```js
[
  {
    $group: {
      _id: "$Model Year",
      "Unladen Weight_sum": { $sum: "$Unladen Weight.sum" },
      "Unladen Weight_count": { $sum: "$Unladen Weight.count" },
    },
  },
  {
    $set: {
      "Unladen Weight_avg": {
        $cond: {
          if: { $eq: ["$Unladen Weight_count", 0] },
          then: null,
          else: {
            $divide: ["$Unladen Weight_sum", "$Unladen Weight_count"],
          },
        },
      },
    },
  },
  { $project: { _id: 1, avg_weight: "$Unladen Weight_avg" } },
  { $sort: { avg_weight: -1 } },
  { $limit: 3 },
];
```

This pipeline looks more complex than the original pipeline, because it had to calculate the average explicitly from the sum
and count. It also handles the case of zero results to avoid a division by zero.

Again we compare the original query with the query against the view:

```
// took 18.5 seconds
datasets> db.dmv.aggregate(p2)
[
  { _id: 1989, avg_weight: 5609.290380622838 },
  { _id: 1988, avg_weight: 5570.567449891149 },
  { _id: 1990, avg_weight: 5490.509740483238 }
]

// took 68 milliseconds
datasets> db.dmv.cube.aggregate(cubes.queryCube(p2))
[
  { _id: 1989, avg_weight: 5609.290380622838 },
  { _id: 1988, avg_weight: 5570.567449891149 },
  { _id: 1990, avg_weight: 5490.509740483238 }
]
```
