import time
from processor.src.processor import background_process
from shared.logger import logger

def run_continuous():
    """Run the processor in a continuous loop, checking the queue every 10 seconds"""
    logger.info("Starting continuous processor...")
    
    while True:
        try:
            background_process()
        except Exception as e:
            logger.error(f"Error in processor loop: {e}")
        
        time.sleep(10)

if __name__ == '__main__':
    run_continuous()