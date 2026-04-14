const Legend = () => {
  return (
    <div className="flex min-w-fit flex-col items-end space-x-2 rounded-md bg-white p-4">
      <p className="m-0 max-w-24 pb-2 text-center text-xs text-gray-500">Share of standing deadwood (%)</p>
      <div className="flex h-32 space-x-2">
        <div className="flex flex-col items-end justify-between">
          <p className="m-0 text-xs text-gray-600">100% - </p>
          <p className="m-0 text-xs text-gray-600">50% - </p>
          <p className="m-0 text-xs text-gray-600">0% - </p>
        </div>
        <div className="mb-1 mt-1  w-4 rounded-sm bg-gradient-to-b from-sky-500"></div>
      </div>
    </div>
  );
};

export default Legend;
