function getOptimizedPagination(total, offset, limit) {
  let queryOrder = 'DESC';
  let queryOffset = offset;
  let queryLimit = limit;
  let reverseResults = false;

  if (offset > total / 2) {
    queryOrder = 'ASC';
    queryOffset = total - offset - limit;
    if (queryOffset < 0) {
      queryLimit += queryOffset;
      queryOffset = 0;
    }
    reverseResults = true;
  }
  
  return { queryOrder, queryOffset, queryLimit, reverseResults };
}

console.log(getOptimizedPagination(10, 7, 2)); // expect ASC, offset 1, limit 2
console.log(getOptimizedPagination(10, 8, 5)); // expect ASC, offset 0, limit 2
console.log(getOptimizedPagination(100000, 99900, 100)); // expect ASC, offset 0, limit 100
