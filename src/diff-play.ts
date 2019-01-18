import * as diff from "diff";

const one = {
    name: "Jason",
    age: 5
};

const other = {
    name: "Jason",
    age: 7
};

const oneA = ["Jason", "John"];
const otherA = ["Jason", "Barry", "John"];

const result = diff.diffArrays(oneA, otherA);
console.log("result", result);